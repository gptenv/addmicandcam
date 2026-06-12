# Media Limitations

Chromium fake camera support is practical when the browser is launched with `--use-fake-device-for-media-stream` and `--use-file-for-fake-video-capture=/path/to/file.y4m`. The app converts uploaded images and videos into Y4M files with ffmpeg and relaunches the isolated session when that source changes.

Fake microphone support is less portable. Chromium has a `--use-file-for-fake-audio-capture=/path/to/file.wav` flag, and this app uses it for uploaded audio, generated TTS, and silence. Browser builds, platforms, and WebRTC sites vary, so treat this as experimental.

Fallbacks and advanced options:

- The app can generate TTS WAV assets and play or download them from the control UI.
- Session mic mode `silence` also installs a best-effort Web Audio `getUserMedia` fallback for pages that call the standard API.
- Full host-level virtual microphone support usually requires PulseAudio, PipeWire, or another virtual source configured outside the container.
- Full host-level virtual camera support usually requires `v4l2loopback` or an OS-specific virtual camera driver.
- Cloud containers often cannot expose kernel loopback audio/video devices.

Changing fake camera or fake audio capture files requires relaunching the Chromium session. The app preserves the current URL, but page state held only in memory by the target site may reset.
