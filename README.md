# Tinder Power Mode

Keyboard controls, photo navigation and a compact HUD for Tinder web. Each decision is triggered by your input and clicks an existing page control. There is no API integration, automatic swiping, profile collection or account connection.

**[Try the interactive demo](https://Ademord.github.io/tinder-power-mode/)** · **[Install v1.1.2](https://Ademord.github.io/tinder-power-mode/tinder-power-mode.user.js)** · **[Report an issue](https://github.com/Ademord/tinder-power-mode/issues)**

The demo uses fictional adult profiles and generated color artwork, and executes the actual distributed userscript. It proves behavior against a simulation. Live Tinder compatibility and physical controller compatibility have **not** been verified for this release. Tinder's markup, labels and available controls can change.

## Install and update

1. Install [Tampermonkey](https://www.tampermonkey.net/) for your browser.
2. Open the **Install v1.1.2** link above. In the userscript manager, review the script name, version and its two matching sites: `tinder.com` and `www.tinder.com`. Then install it.
3. Open or reload Tinder web. The HUD appears when a recognizable card page is present. Press **O** for options.

If the installation link shows source text, open Tampermonkey's dashboard, create a script, replace its contents with [tinder-power-mode.user.js](./tinder-power-mode.user.js), and save. Check your browser's extension and userscript permissions using [Tampermonkey's documentation](https://www.tampermonkey.net/faq.php).

The installed script declares the public Pages `.user.js` URL for updates. Use Tampermonkey's update check, or reopen the install link to review and apply a newer version. Keep only one enabled copy. The script name, namespace (`tinder-power-mode`) and settings key (`tpm.settings.v1`) are preserved from v1.1.1 so existing preferences can carry forward.

To remove it, disable or delete it in Tampermonkey. **Options → Reset defaults** restores bindings, sizing, HUD settings and focus mode. Preferences are stored in the matching site's `localStorage`; the two Tinder hostnames and the demo have separate origins.

## Controls

| Input | Action |
| --- | --- |
| A / D | Nope / Like |
| S / R | Super Like / Rewind |
| ← / → | Previous / next photo, wrapping at the ends |
| 1–9 | Jump directly to a photo; these digits are reserved |
| Shift + Space | Previous photo |
| W | Open or close the profile |
| Esc | Close options first, then profile; passes through if neither is open |
| F | Toggle focus mode; the sidebar returns on non-card routes |
| X | Fit card to the available column |
| Shift + ← / → | Adjust card width in 32 px steps |
| Shift + ↑ / ↓ | Adjust card height in 32 px steps |
| + / − / 0 | Increase size / decrease size / restore the site's stock size |
| H or ? | Cycle full HUD → mini → hidden |
| O | Open options and remap bindings |
| P | Write sanitized diagnostics to the console; copy them if clipboard permission allows |

Native ↑, ↓, Space and Enter are left to Tinder unless you bind them in Options. Native behavior belongs to the host site; the userscript's decision safeguards do not intercept unbound native keys or direct clicks on Tinder controls.

Options also offer exact card dimensions, an 800 × 1280 preset, HUD position, photo repeat, stamps, controller input and the decision cooldown. Click a binding or focus it with Tab and press Enter, then press its replacement; Backspace/Delete removes it and Esc cancels. Assigning a key to a new action removes its prior assignment. Tab and Shift+Tab stay within Options, and closing the dialog restores focus to its invoking control when it is still present.

The HUD shows the current photo, profile name, visible Super Like balance and disabled action hints. These details stay on the current page; they are excluded from diagnostics.

## Decision and input guards

- Repeated decision input is ignored during the default **450 ms** cooldown. Holding a decision key does not repeat it.
- Disabled controls are not clicked. A visible zero balance blocks Super Like or Boost. Boost has no default keyboard binding.
- Keyboard and controller shortcuts pause while typing in an input, textarea, select or editable field.
- Recognized blocking dialogs outside the main content pause card actions, including HUD clicks. This is a DOM heuristic, not a guarantee that every future dialog is recognized.
- Photo navigation targets an expanded profile before the active card, avoiding inert cards behind it. An empty deck does not activate leftover decision buttons.

Controller input uses the browser Gamepad API with a standard button mapping: A Like, B Nope, X Rewind, Y Super Like, LB/RB or D-pad left/right photos, D-pad up/down profile, Back focus, Start HUD. Input fires on button-down edges. Actual browser/device support is unverified; toggle it off in Options if unused.

## Try the simulation

The [demo](https://Ademord.github.io/tinder-power-mode/) starts in manual mode. Press →, click a photo control, or use the demo lab. **Play tour** runs a guided sequence using synthetic keyboard events through the same script. Any keyboard input or click inside the demo pauses the tour.

Try **Simulate exhausted actions**, **Open simulated dialog**, and the typing field to inspect the guards. **Options** opens the actual script's controls. Demo preferences persist on the demo's origin; the header's **Reset** clears only the `tpm.settings.v1` preference key there and restores the fictional deck. The demo begins at stock card size to fit its surrounding frame; the installed userscript defaults to fit mode.

The demo loads no remote fonts, images, analytics or runtime services. Loading the page itself requires its host unless you serve the files locally. Install and source links intentionally navigate to their targets. On a narrow screen, **Demo controls** opens a touch-friendly panel for photo, decision and guard scenarios, and the HUD initially uses mini mode unless it was switched off. The card is constrained to fit the demo frame. A keyboard is needed to try physical keyboard shortcuts; touch controls exercise the same script actions.

## Troubleshooting and privacy

If a shortcut does nothing, leave any typing field, dismiss open dialogs, confirm the script is enabled on the current hostname, and reload. If you remapped **O** or hid the HUD, use the new binding or reload with the script disabled to recover access. Check for duplicate installed versions. Disabled Rewind or zero Super Likes reflect the page state and are not unlocked by this script.

If the site changes, press **P**. Diagnostics contain only the script version, structural flags and photo counts, numeric viewport/card dimensions, availability counts for fixed action names, and fixed diagnostic reasons. They omit names, ages, conversation text, arbitrary button/ARIA text, CSS classes, DOM nodes, URLs and saved preference strings. Clipboard success or failure is shown in a toast; console output is available either way. Exception handlers also omit the original exception payload.

Review diagnostics before sharing them in an issue. Include your browser and userscript manager versions and the steps that failed; no account data or profile screenshots are needed. The script has no runtime network calls or telemetry. Preferences live in site storage, so other code on that same origin can access them. A host page controls its own telemetry; the script's overlay carries `data-sentry-block` but this does not guarantee that a host cannot observe it.

## Build and verify

Requires Node.js 20 or newer. Runtime installation is a single dependency-free `.user.js` file; jsdom is a pinned development dependency only.

```sh
npm ci
npm run build
npm test
```

`demo/build.js` inlines the real userscript into `demo/src.html` and writes exactly three Pages artifacts: `docs/index.html`, `docs/tinder-power-mode.user.js`, and `docs/.nojekyll`. The install artifact is byte-identical to the source. `npm test` first checks that the committed output matches both sources, then runs the DOM contracts.

Tests cover keyboard and native-key routing, action cooldowns and disabled/zero balances, active-card and expanded-profile targeting, remapping, editable fields, modal and empty-deck guards, focus/HUD/sizing persistence, controller edge events, default reset, clipboard failure, and privacy sentinels in both card and profile diagnostics. jsdom uses explicit synthetic geometry and a simulated Gamepad API, and blocks external resources. It does not validate browser layout, live Tinder selectors or physical controllers.

Publish GitHub Pages from the **main branch, `/docs` folder**. Run build and test before committing changes to the userscript or demo source. No build service or runtime backend is required.

## License

[MIT](./LICENSE) © 2026 Francisco Ribera. Independent project; not affiliated with Tinder.
