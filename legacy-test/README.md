Temporary A/B artifact, 2026-08-27.

`legacy-test/index.html` is the byte-for-byte pre-2026-08-26 page (redirect
fired from inside <head>). It exists only so the current page and the original
can be compared on the same physical device in the same session, to settle
whether iOS's scheme confirmation dialog is decided by redirect timing or by
OS-side state.

DELETE THIS DIRECTORY once that question is answered.
