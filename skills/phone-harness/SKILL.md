---
name: phone-harness
description: "Control, inspect, test, or automate a physical Android phone connected to OpenMausBot over authorized USB debugging. Use only when the task requires operating or inspecting a connected physical Android phone; generic mobile-app development, browser interaction, or screenshots alone do not trigger this workflow."
---

# Phone Harness

Use the `phone` tools for every requested Android action. Never replace them
with Bash, raw `adb`, `subprocess`, an emulator, network ADB, or Tailscale.

1. Call `status` before the first action. If the device is missing or
   unauthorized, pause device-dependent steps and relay the physical setup
   instruction. Continue authorized work that does not require the phone; do
   not bypass the required tools or USB authorization.
2. When the task requires opening an app, call `open_app` with the human app
   name. For a task on the current screen, read that screen first. Do not scan
   the launcher first.
   Use `list_apps` only when the name is ambiguous.
3. Call `read_screen` before choosing a target and after every action. Prefer
   `tap_text`; use `screenshot` and pixel `tap` only when accessibility text
   cannot identify the target.
4. Use `swipe`, `type_text`, and `press` for interaction, verifying each step.

The tools operate the user's real phone. Navigate and read only what the task
needs. Stop before sending, posting, purchasing, booking, deleting, changing
settings, entering protected information, or accepting an unexpected legal or
security prompt unless the user has explicitly authorized that exact action.
Do not ask again when the same target, content, action, and authorization remain
valid. A changed target or consequence requires fresh authorization.

Never enter passwords, payment details, government identifiers, or one-time
codes, even when requested. The authorization exception above does not override
this restriction. Ask the user to complete these steps directly on the phone.
