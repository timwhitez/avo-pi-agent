# Run and publish final real-provider repair result

Queues the final immutable full-evidence analyze → repair → rerun workflow. It reads the latest complete-public redacted baseline artifact and publishes the exact combined result itself, eliminating cross-workflow wait races. No credential is stored here.
