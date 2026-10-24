# Talk with them (Ian)

You speak; someone you love answers in their own cloned voice. A small Node server (no packages) on a Mac holds the API
keys, so they never ship inside the Quest app.

1. **Hears you:** OpenAI transcribes what you said (Vietnamese or English, `whisper-1`).
2. **Writes the reply:** OpenAI (`gpt-4o-mini`) answers as the person, from the rules in `server.mjs` and the private notes
   in `persona.md`, remembering the last few turns. Vietnamese, with an English line for the captions.
3. **Says it:** ElevenLabs speaks it in their cloned voice (`eleven_flash_v2_5`, the fastest model that speaks
   Vietnamese; about 0.5 s).

About 3 s from the end of your question to their voice. Every reply is AI and is labelled "AI voice" wherever it plays;
it never claims memories it wasn't given (AGENTS.md rules 5 and 6: only with the person's and family's consent).

## Run it

```
node apps/talk/server.mjs
```

Then open `http://localhost:5175` on that Mac (it fills in the token itself; from another device add
`?token=<TALK_TOKEN>`): press Talk, speak, press Send.

`apps/talk/.env` (git-ignored) holds `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` (the cloned voice) and
`TALK_TOKEN` (every call needs it, so nobody else on the Wi-Fi can use the keys or hear the voice). `persona.md`
(git-ignored) is what's true about the person, one line each; edit it any time, it's read on every turn.

## On the Quest

The palm menu shows **Talk** in companion mode once the app knows the server. Put its address in the app's storage:

```
adb shell "echo 'http://<this Mac>:5175/?token=<TALK_TOKEN>' > /sdcard/Android/data/com.luciddreams.quest/files/talk.txt"
```

Press **Talk**, speak, press **Send**: the reply plays from their mouth (their clip's own voice waits), with the words
and the English on the caption, labelled AI voice. The first press asks for the microphone.

| Call | Body / reply |
| --- | --- |
| `POST /api/talk?token=&session=` | audio (WAV, WebM or M4A) -> `{ heard, reply, english, audio, ms }` |
| `GET /api/talk/audio/<id>.wav?token=` | the reply in their voice (16-bit mono WAV, kept 10 minutes) |
| `POST /api/talk/reset?token=&session=` | forget the conversation |
