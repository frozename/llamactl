// Copyright © 2023 Apple Inc.

#pragma once

#include <atomic>
#include <chrono>
#include <future>
#include <limits>
#include <queue>
#include <shared_mutex>
#include <sstream>
#include <thread>
#include <unordered_map>

#include "mlx/api.h"
#include "mlx/backend/gpu/eval.h"
#include "mlx/device.h"
#include "mlx/stream.h"

namespace mlx::core::scheduler {

struct StreamThread {
  std::mutex mtx;
  std::queue<std::function<void()>> q;
  std::condition_variable cond;
  bool stop;
  std::thread thread;

  StreamThread() : stop(false), thread(&StreamThread::thread_fn, this) {}

  ~StreamThread() {
    {
      std::lock_guard<std::mutex> lk(mtx);
      stop = true;
    }
    cond.notify_one();
    thread.join();
  }

  void thread_fn() {
    while (true) {
      std::function<void()> task;
      {
        std::unique_lock<std::mutex> lk(mtx);
        cond.wait(lk, [this] { return !this->q.empty() || this->stop; });
        if (q.empty() && stop) {
          return;
        }
        task = std::move(q.front());
        q.pop();
      }

      task();
    }
  }

  void enqueue(std::function<void()> f) {
    {
      std::lock_guard<std::mutex> lk(mtx);
      if (stop) {
        throw std::runtime_error(
            "Cannot enqueue work after stream is stopped.");
      }
      q.emplace(std::move(f));
    }
    cond.notify_one();
  }
};

class MLX_API Scheduler {
 public:
  Scheduler();
  ~Scheduler();

  // Not copyable or moveable
  Scheduler(const Scheduler&) = delete;
  Scheduler(Scheduler&&) = delete;
  Scheduler& operator=(const Scheduler&) = delete;
  Scheduler& operator=(Scheduler&&) = delete;

  void enqueue(Stream s, std::function<void()> task);

  void notify_new_task(const Stream& stream) {
    {
      std::lock_guard<std::mutex> lk(mtx);
      n_active_tasks_++;
    }
    completion_cv.notify_all();
  }

  void notify_task_completion(const Stream& stream) {
    {
      std::lock_guard<std::mutex> lk(mtx);
      n_active_tasks_--;
    }
    completion_cv.notify_all();
  }

  int n_active_tasks() const {
    return n_active_tasks_;
  }

  // Stash an exception on a stream from a background thread (e.g. a Metal
  // completion handler running on libdispatch). Cannot throw from those
  // contexts — see mlx-explore/mlx#2670. If a stream already has a pending
  // error, the new one is dropped (first error wins).
  //
  // The sentinel transition runs INSIDE `error_mtx_` so it cannot race
  // against a concurrent `throw_if_stream_error` lowering the sentinel
  // after observing an empty map (otherwise an insertion+sentinel-raise
  // sequencing against an erase+sentinel-lower sequence could end with
  // the slot populated but the sentinel false, stranding the error).
  void notify_stream_error(const Stream& stream, std::exception_ptr eptr) {
    if (!eptr) return;
    std::lock_guard<std::mutex> lk(error_mtx_);
    auto& slot = stream_errors_[stream.index];
    if (slot.eptr) {
      return; // first error wins; drop subsequent
    }
    slot = {stream.generation, std::move(eptr)};
    any_stream_error_.store(true, std::memory_order_release);
  }

  // If the given stream has a stashed error, clear and re-throw it on the
  // calling thread. Must be called from a synchronous waitpoint where the
  // exception can be caught (e.g. at the entry of eval/finalize/sync).
  //
  // Hot path: the atomic sentinel makes the common (no-error) case a
  // single acquire-load with no mutex acquisition, so this is safe to
  // call on every `eval()` without measurable throughput cost. The
  // sentinel is mutated only while holding `error_mtx_`, so the cleared
  // observation that a no-pending reader gets via this fast path is
  // tied to a real lock-protected emptiness check by some other thread.
  void throw_if_stream_error(const Stream& stream) {
    if (!any_stream_error_.load(std::memory_order_acquire)) {
      return;
    }
    std::exception_ptr eptr;
    {
      std::lock_guard<std::mutex> lk(error_mtx_);
      auto it = stream_errors_.find(stream.index);
      if (it != stream_errors_.end()) {
        if (it->second.generation == stream.generation) {
          eptr = std::move(it->second.eptr);
        }
        // Erase unconditionally: a stale entry (generation mismatch) from
        // a previous stream incarnation is silently discarded rather than
        // surfaced on the new stream.
        stream_errors_.erase(it);
      }
      // Sentinel transition INSIDE the lock so a concurrent
      // notify_stream_error cannot insert after we observed the map
      // empty but before we cleared the flag.
      if (stream_errors_.empty()) {
        any_stream_error_.store(false, std::memory_order_release);
      }
    }
    if (eptr) {
      std::rethrow_exception(eptr);
    }
  }

  // Drop any stashed error for `stream` without rethrowing. Called from
  // stream lifecycle hooks (gpu::new_stream / clear_streams) to sweep out
  // any leftover entry before the slot is recycled. The erase is by index
  // only — not by generation — so it clears regardless of incarnation.
  // Any late-arriving completion handler from the old incarnation that calls
  // notify_stream_error after this point will store with the old generation;
  // throw_if_stream_error on the new stream will then discard it on mismatch.
  void clear_stream_error(const Stream& stream) {
    {
      std::lock_guard<std::mutex> lk(error_mtx_);
      stream_errors_.erase(stream.index);
      if (stream_errors_.empty()) {
        any_stream_error_.store(false, std::memory_order_release);
      }
    }
    // Drop the in-flight count for this stream as part of the same
    // lifecycle: when the backend resets a stream we also forget any
    // commits that were in flight against the previous incarnation.
    {
      std::lock_guard<std::mutex> lk(inflight_mtx_);
      stream_inflight_.erase(stream.index);
    }
    inflight_cv_.notify_all();
  }

  // Drop all stashed errors across all streams. Called from
  // `clear_streams()` during backend reset / shutdown. Both transitions
  // are sequenced under the mutex.
  void clear_all_stream_errors() {
    {
      std::lock_guard<std::mutex> lk(error_mtx_);
      stream_errors_.clear();
      any_stream_error_.store(false, std::memory_order_release);
    }
    // Back-pressure state shares the stream lifecycle but lives under a
    // separate mutex (see `inflight_mtx_` rationale below).
    {
      std::lock_guard<std::mutex> lk(inflight_mtx_);
      stream_inflight_.clear();
    }
    inflight_cv_.notify_all();
  }

  // Acquire a slot on stream `s` before committing a Metal command buffer.
  // Blocks while `stream_inflight_[s.index] >= limit`. When
  // `limit == std::numeric_limits<int>::max()` (the default / unset env
  // var case) the wait is skipped: one mutex acquisition, no condition
  // variable wait. On timeout the call publishes a backpressure error
  // through `notify_stream_error` so the caller's next
  // `throw_if_stream_error` waitpoint rethrows it. The in-flight counter
  // is NOT incremented on timeout.
  //
  // `inflight_mtx_` is intentionally a different mutex from `error_mtx_`:
  // the timeout branch calls `notify_stream_error` which takes
  // `error_mtx_`. Holding two of our mutexes simultaneously is forbidden
  // — drop `inflight_mtx_` before calling `notify_stream_error` so the
  // never-nest invariant rules out deadlock.
  void acquire_stream_slot(
      const Stream& s,
      int limit,
      int timeout_secs = 30) {
    if (limit == std::numeric_limits<int>::max()) {
      std::lock_guard<std::mutex> lk(inflight_mtx_);
      ++stream_inflight_[s.index];
      return;
    }
    bool timed_out = false;
    {
      std::unique_lock<std::mutex> lk(inflight_mtx_);
      timed_out = !inflight_cv_.wait_for(
          lk,
          std::chrono::seconds(timeout_secs),
          [this, &s, limit] {
            return stream_inflight_[s.index] < limit;
          });
      if (!timed_out) {
        ++stream_inflight_[s.index];
      }
    }
    if (timed_out) {
      std::ostringstream msg;
      msg << "[MLX] backpressure timeout on stream " << s.index
          << " after " << timeout_secs << " s";
      notify_stream_error(
          s, std::make_exception_ptr(std::runtime_error(msg.str())));
    }
  }

  // Release a slot previously acquired by `acquire_stream_slot`. Safe to
  // call from a Metal completion handler — does not throw, does not
  // allocate, and the notify_all is outside the critical section so
  // waiters wake without re-acquiring against this thread.
  void release_stream_slot(const Stream& s) {
    {
      std::lock_guard<std::mutex> lk(inflight_mtx_);
      auto it = stream_inflight_.find(s.index);
      if (it != stream_inflight_.end() && it->second > 0) {
        --it->second;
      }
    }
    inflight_cv_.notify_all();
  }

  void wait_for_one() {
    std::unique_lock<std::mutex> lk(mtx);
    int n_tasks_old = n_active_tasks();
    if (n_tasks_old > 1) {
      completion_cv.wait(lk, [this, n_tasks_old] {
        return this->n_active_tasks() < n_tasks_old;
      });
    }
  }

 private:
  friend Stream mlx::core::new_stream(Device d);

  int n_active_tasks_{0};
  std::unordered_map<int, std::unique_ptr<StreamThread>> threads_;
  std::shared_mutex threads_mtx_;
  std::condition_variable completion_cv;
  std::mutex mtx;
  // Value type for stream_errors_. Stores the generation of the stream that
  // stashed the error alongside the exception_ptr so throw_if_stream_error
  // can discard entries from a previous stream incarnation that reused the
  // same index.
  struct StreamErrorEntry {
    uint64_t generation{0};
    std::exception_ptr eptr;
    explicit operator bool() const noexcept { return eptr != nullptr; }
  };
  std::unordered_map<int, StreamErrorEntry> stream_errors_;
  std::mutex error_mtx_;
  // Hot-path sentinel: true iff at least one stream has a stashed error.
  // Lets `throw_if_stream_error` short-circuit on the common no-error path
  // without touching the mutex.
  std::atomic<bool> any_stream_error_{false};

  // Per-stream in-flight Metal command-buffer counts; guarded by
  // `inflight_mtx_`. Waiters block on `inflight_cv_` until the count
  // drops below the configured `MLX_METAL_MAX_INFLIGHT_PER_STREAM`
  // limit, with a finite fallback timeout that routes through the
  // existing stream-error stash.
  std::unordered_map<int, int> stream_inflight_;
  std::mutex inflight_mtx_;
  std::condition_variable inflight_cv_;
};

MLX_API Scheduler& scheduler();

template <typename F>
void enqueue(const Stream& stream, F&& f) {
  scheduler().enqueue(stream, std::forward<F>(f));
}

inline int n_active_tasks() {
  return scheduler().n_active_tasks();
}

inline void notify_new_task(const Stream& stream) {
  scheduler().notify_new_task(stream);
}

inline void notify_task_completion(const Stream& stream) {
  scheduler().notify_task_completion(stream);
}

inline void notify_stream_error(
    const Stream& stream,
    std::exception_ptr eptr) {
  scheduler().notify_stream_error(stream, std::move(eptr));
}

inline void throw_if_stream_error(const Stream& stream) {
  scheduler().throw_if_stream_error(stream);
}

inline void clear_stream_error(const Stream& stream) {
  scheduler().clear_stream_error(stream);
}

inline void clear_all_stream_errors() {
  scheduler().clear_all_stream_errors();
}

inline void acquire_stream_slot(
    const Stream& stream,
    int limit,
    int timeout_secs = 30) {
  scheduler().acquire_stream_slot(stream, limit, timeout_secs);
}

inline void release_stream_slot(const Stream& stream) {
  scheduler().release_stream_slot(stream);
}

inline void wait_for_one() {
  scheduler().wait_for_one();
}

} // namespace mlx::core::scheduler
