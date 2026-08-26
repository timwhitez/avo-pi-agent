# Method-aware authoritative four-job repair rerun

Replaces every earlier pending repair-v10 snapshot. The stable recorder v4 now delegates to tested recorder v5, which recognizes `method + params` and legacy operation shapes, records exact ARC transitions, supervisor evidence markers, durable memory/lineage hashes, and private process evidence. No credential is stored here.
