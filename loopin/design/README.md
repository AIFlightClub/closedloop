# Design handoff

**tokens.css is binding, the .dc.html is reference only, the screenshots are the target.**

Source: https://claude.ai/code/artifact/29a57b2b-8e72-4062-9b7f-5b8eba4dabaf

The live Claude project was opened and its Skip ahead control used to inspect organizer detection, compose, waiting, success and attendee prompt/question/idle scenes. `reference-screens/` contains captures of that original project, including its original cast. These captures are reference evidence, not the canonical demo data.

`screens/` contains the independently implemented React scenes with the canonical Obaid/Zaid/Nouman/Sharjeel cast and ClosedLoop Sync title. These are implementation captures checked against the source, not falsely attributed to the source designer. The date scenes extend the supplied owner flow with the same tokens/layout.

`LoopIn Zoom App.dc.html` and `support.js` are preserved exports. They require remote runtime dependencies and are not part of the built app. Production fonts, React and Zoom SDK are bundled locally. Mock Zoom chrome is confined to the offline scene player.
