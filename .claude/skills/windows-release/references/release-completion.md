# Cross-platform release completion

These requirements apply when shipping a new version, not to a diagnosis or a
Windows-only artifact build. Follow the repository's [approval rules](../../../../AGENTS.md)
for external release actions; this reference grants no additional permission.

- Every new release ships macOS and Windows artifacts under the same version
  tag. Build and verify each on its required machine; do not claim the whole
  release is complete after only one platform passes.
- If Windows cannot ship, prepare and report the available results and blocker.
  Do not publish a macOS-only new version unless the unique Owner explicitly
  approves that exception for the fixed release. Disclose the Windows delay in
  release notes; the agent cannot accept it on the Owner's behalf.
- Windows delivery includes the versioned installer, byte-identical stable-name
  installer, blockmap, and generated `latest.yml`. Do not hand-edit or reuse an
  old update feed; its filename and sha512 must match the installer.
- Release completion requires both platforms' verification and approved upload
  results, or the explicitly approved platform exception. An upload command
  without a verified successful result is not completion.
