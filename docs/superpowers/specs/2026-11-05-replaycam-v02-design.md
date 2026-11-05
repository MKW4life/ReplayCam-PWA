# ReplayCam v0.2 design

Approved in chat: add 1440p and 4K choices, show requested versus actual capture values, estimate storage, clearly identify front/rear cameras, merge replay segments locally with ZIP fallback. Preserve existing recordings and never upload video.

Approaches: local remuxing is selected over server processing (privacy and operating cost) and full transcoding (CPU, memory and quality cost). Use pinned, self-hosted Mediabunny and a worker to remux encoded video/audio with normalized timestamps and rotation preserved. Reject incompatible tracks instead of silently discarding audio. Retain explicit ZIP export. A conservative 256 MiB input limit protects mobile memory; large or incompatible recordings remain exportable as ZIP. No claim of gap repair or universal iPhone compatibility.

Storage: preset bitrate plus audio gives a pre-recording estimate; recorded byte/duration samples replace it while recording. Display replay window or per-minute continuous estimate, separate site usage/quota and temporary export overhead. Actual camera settings are authoritative; requested settings are only preferences.

Camera: explicit front/rear selector, persistent requested label while idle and actual facing while active (unknown if browser does not report it). Disable changes during recording. Never infer actual camera from a requested preference.

Version cache as v0.2.0, retain IndexedDB schema, self-host all runtime dependencies, document test/device limitations and public sharing.
