# Optional Host Virtual Devices

The app works without host loopback devices for its first implementation path: Chromium fake video capture files and experimental fake audio files. For production-grade live media routing, configure virtual devices on the host and run Chromium with access to them.

## Linux Virtual Camera

Typical packages:

```bash
sudo apt-get install v4l2loopback-dkms v4l2loopback-utils ffmpeg
sudo modprobe v4l2loopback devices=1 video_nr=10 card_label="TelepresenceCam" exclusive_caps=1
```

Feed a video into the device:

```bash
ffmpeg -re -stream_loop -1 -i avatar.mp4 -vf format=yuv420p -f v4l2 /dev/video10
```

Docker containers usually need extra device and kernel access for this mode, so it is intentionally not enabled by default.

## Linux Virtual Microphone

PulseAudio example:

```bash
pactl load-module module-null-sink sink_name=telepresence_sink sink_properties=device.description=TelepresenceSink
pactl load-module module-remap-source master=telepresence_sink.monitor source_name=telepresence_mic source_properties=device.description=TelepresenceMic
ffmpeg -re -stream_loop -1 -i speech.wav -f pulse telepresence_sink
```

PipeWire systems often expose PulseAudio-compatible commands through `pipewire-pulse`, but details vary by distribution.

## Operator Notes

- Host virtual devices should be visible and documented for all participants who need disclosure.
- Device names and permissions vary across distributions and cloud runtimes.
- Cloud containers commonly cannot load kernel modules or expose host audio graphs.
