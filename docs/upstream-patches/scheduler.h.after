// Copyright © 2023 Apple Inc.

#pragma once

#include <atomic>
#include <future>
#include <queue>
#include <shared_mutex>
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
    if (slot) {
      return; // first error wins; drop subsequent
    }
    slot = std::move(eptr);
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
        eptr = std::move(it->second);
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
  // stream lifecycle hooks (creation / teardown / clear) to prevent a
  // stale exception from a previous stream incarnation surfacing on a new
  // stream that happens to reuse the same index.
  //
  // Known limitation: a Metal completion handler captured a Stream by
  // value before the stream was torn down will still call
  // notify_stream_error with the old index after this clear. If the
  // index was recycled to a new stream the new stream sees the error
  // on its next sync waitpoint. Closing that window requires embedding
  // a generation token in Stream, which is an upstream API change. In
  // practice user code synchronizes before destroying a stream, which
  // closes the window without an API change.
  void clear_stream_error(const Stream& stream) {
    std::lock_guard<std::mutex> lk(error_mtx_);
    stream_errors_.erase(stream.index);
    if (stream_errors_.empty()) {
      any_stream_error_.store(false, std::memory_order_release);
    }
  }

  // Drop all stashed errors across all streams. Called from
  // `clear_streams()` during backend reset / shutdown. Both transitions
  // are sequenced under the mutex.
  void clear_all_stream_errors() {
    std::lock_guard<std::mutex> lk(error_mtx_);
    stream_errors_.clear();
    any_stream_error_.store(false, std::memory_order_release);
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
  std::unordered_map<int, std::exception_ptr> stream_errors_;
  std::mutex error_mtx_;
  // Hot-path sentinel: true iff at least one stream has a stashed error.
  // Lets `throw_if_stream_error` short-circuit on the common no-error path
  // without touching the mutex.
  std::atomic<bool> any_stream_error_{false};
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

inline void wait_for_one() {
  scheduler().wait_for_one();
}

} // namespace mlx::core::scheduler
