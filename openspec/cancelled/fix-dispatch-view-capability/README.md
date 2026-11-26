# fix-dispatch-view-capability

The v2 dispatch client never had a messages reader (the session domain exposes 18 methods, none named messages; the v1 SDK client method is absent on 2.3.2), so every poll tick threw 'is not a function' and the watch lived on the stream-loss withholding guard. Give the v2 adapter a real HTTP-backed messages reader (upstream-sanctioned session.message.list surface via service.json discovery), make the core capability-aware (absence is not failure), and stop the per-hold unreadable-view disclosure when the view was never there.
