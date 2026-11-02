# TLS identity for forwarded agent endpoints

An SSH local forward changes the address a client connects to, while the agent
continues to present its own certificate. Configure `tlsServerName` on the
kubeconfig node when the forwarded endpoint hostname differs from the name in
that certificate:

```yaml
nodes:
  - name: worker
    endpoint: https://127.0.0.1:17843
    tlsServerName: worker.example.test
    certificate: |
      -----BEGIN CERTIFICATE-----
      # The worker certificate obtained through a trusted channel.
      -----END CERTIFICATE-----
    certificateFingerprint: sha256:<worker-certificate-fingerprint>
```

The example is a node entry within an existing kubeconfig cluster. Keep its
context and user configuration, including the agent bearer token, as usual.
Create and maintain the SSH forward separately; this setting does not open a
forward or change the agent listener.

`tlsServerName` selects the certificate identity to verify and the TLS server
name sent on the connection. It must match a DNS name or IP address in the
agent certificate's Subject Alternative Name extension. The endpoint remains
the transport address. Without an override, clients continue to verify the
endpoint hostname.

The supplied certificate remains the trust anchor, and its configured
fingerprint must match before a connection is attempted. A different CA,
incorrect certificate name, or mismatched fingerprint is refused. This setting
does not disable certificate verification or replace bearer authentication.

The configured identity is used by CLI and Electron node dispatch, peer
snapshot and health polling, infrastructure calls, direct peer inference, and
the OpenAI proxy's peer forwarding. Reverse-tunnel authentication and the
central relay's TLS configuration retain their existing behavior.
