# ComfyUI LAN Image Server & Live Viewer

A custom node for ComfyUI that streams real-time KSampler step previews and serves full-resolution image history across your local area network (LAN) to any browser or mobile device.

---

## Features

- **Three-Tab Mobile Interface**: Designed with a responsive layout that fits mobile viewports (iOS & Android) perfectly with **Gallery**, **Live Preview**, and **Prompt** tabs.
- **Remote Workflow Execution**: Trigger workflow runs directly from your mobile device via the persistent **Run** and **Run (Instant)** buttons.
- **Run (Instant) Continuous Loop**: Keep generating in a continuous loop—tap "Stop Loop" or "Cancel" anytime to halt.
- **Instant Generation Cancel**: Abort running KSampler steps and clear pending queues on the fly with the **Cancel** button.
- **LAN Prompt / Text Customization**: View and edit prompts remotely from any connected device. Save customized prompts on the fly or revert back to the workflow default with a single tap.
- **Real-Time KSampler Live Preview**: Hooks directly into ComfyUI's core WebSocket stream (`send_bytes` / `send_image`) to parse and display `latent2rgb` preview frames frame-by-frame while sampling.
- **Seamless Live-to-Final Transition**: When a workflow run finishes, the **Live Preview** tab automatically updates from the lossy KSampler preview to the full-resolution, VAE-decoded PNG image.
- **Session Gallery & Navigation**: Keeps track of all images generated during the current session with interactive `Prev` and `Next` buttons, a live counter (e.g., `1 / 4`), and state-aware auto-advancing (staying at the latest output unless manually navigating history).
- **Automated Session Cleanup**: Automatically purges temporary image files upon startup for a fresh slate every time ComfyUI launches.
- **Built-in Session Clear**: Clear image history and reset active browser connections directly from the web interface.

---

## Installation

1. Navigate to your ComfyUI `custom_nodes` directory:
   cd ComfyUI/custom_nodes/

2. Clone this repository:
   git clone https://github.com/inxanedev/comfyui-lan-image-server.git

3. Restart ComfyUI.

---

## How to Run & Requirements

To allow other devices on your local Wi-Fi or local network to connect, **ComfyUI must listen on all network interfaces** (`0.0.0.0`). 

Launch ComfyUI with the following command-line arguments:
python main.py --listen 0.0.0.0 --port 8000 --preview-method latent2rgb

> **Note:** You can also use `--preview-method taesd` instead of `latent2rgb`.

---

## Usage Guide

### 1. Remote Prompt Customization (`Serve Text on LAN`)
1. Double-click the ComfyUI canvas, search under the **`inx`** category, and add **`Serve Text on LAN`**.
2. Type your default prompt into `default_text` (or connect an existing string).
3. Connect the `text` output pin to `CLIPTextEncode` (or any node accepting text).
4. On your mobile or LAN browser (`/inx/view`), click the **Prompt** tab:
   - View the current workflow default.
   - Edit the multiline textbox and click **Save** to override with your custom prompt.
   - Click **Revert to default** at any time to clear the custom prompt and restore the workflow default.

### 2. Live Preview & Image Gallery (`Serve Image on LAN`)
1. Add the **`Serve Image on LAN`** node (under **`inx`** category).
2. Connect any image output (e.g., from a VAE Decode node) to the **`Serve Image on LAN`** node's `images` input.
3. Run the workflow once from ComfyUI to activate the LAN session. Your terminal console will print the local network address:
   [Serve Image on LAN] Image added to history (1)
   -> Access: http://192.168.x.x:8000/inx/view

4. Open `http://<your-pc-ip>:8000/inx/view` in any desktop or mobile browser connected to the same Wi-Fi network.

### 3. Remote Control: Run, Run (Instant) Loop & Cancel
Once a workflow has been run at least once in ComfyUI, the bottom action bar allows you to trigger and control generation directly from the web interface across all tabs:
- **Run**: Triggers execution of the active workflow as configured.
- **Run (Instant)**: Enters a continuous loop that automatically queues the next generation as soon as each image is saved. While looping, the button turns into a pulsing **Stop Loop** button to cleanly finish after the current run.
- **Cancel**: Immediately halts the current generation via ComfyUI's interrupt mechanism and wipes any queued prompts.

---

## How It Works

### Backend (`lan_image_server.py`)
- **Web Routes**: Registers custom AIOHTTP server routes directly onto ComfyUI's native `PromptServer` (`/inx/view`, `/inx/image`, `/inx/ws`, `/inx/text`, `/inx/revert_text`, `/inx/kill_server`).
- **Binary Stream Interception**: Hooks into `PromptServer.instance.send_bytes` to capture KSampler step preview frames as they are generated on the server backend.
- **Broadcast System**: Relays binary preview frames, session updates, and live prompt changes across custom WebSocket connections (`/inx/ws`) to all active LAN clients simultaneously.

### Frontend Client (`/inx/view`)
- **Interactive Tabs**: Seamlessly toggle between **Gallery**, **Live Preview**, and **Prompt** editor.
- **Magic Byte Scanning**: Intercepts incoming WebSocket binary ArrayBuffers and scans for standard **JPEG (`0xFF, 0xD8`)** or **PNG (`0x89, 'P', 'N', 'G'`)** magic header bytes. This dynamically strips out ComfyUI's internal JSON metadata prefixes, ensuring raw, valid image blobs are constructed reliably across mobile browsers.
- **Memory Management**: Uses `URL.createObjectURL()` for instant image rendering and automatically calls `URL.revokeObjectURL()` to prevent client-side browser memory leaks during extended generation sessions.

---

## License

No license, use it however you like. This whole thing including the README is vibe coded anyway :D