# Real public benchmark trigger — JSONL logger isolation

This trigger reruns the full real-provider public benchmark after redirecting
all official ARC loggers to stderr and making the Node bridge preserve pending
requests when future SDK versions emit non-JSON diagnostics on stdout.
