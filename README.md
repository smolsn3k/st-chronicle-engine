# Chronicle Engine

**English** | [Русский](README.ru.md)

A plot and story engine for [SillyTavern](https://github.com/SillyTavern/SillyTavern). Build your own worlds as **chronicles** made of arcs, episodes and story beats, then let the model follow your structure while you control the pacing.

Works on desktop and mobile. Progress is saved per chat.

> **Status: v0.1.0.** First release, written against SillyTavern 1.13+. Please open an issue if something breaks on your version.

## Install

1. In SillyTavern, open **Extensions** → **Install extension**.
2. Paste `https://github.com/smolsn3k/st-chronicle-engine` and install.
3. Reload SillyTavern. A floating book button appears. Tap it to open Chronicle Engine.

## Language

The interface is available in English and Russian (Русский). The default is **Auto**, which follows SillyTavern's UI language and falls back to the browser language. You can change it at any time, and it applies instantly:

- **Features** → **General** → **Language**, or
- the Chronicle Engine panel in SillyTavern's extension settings.

What changes with the language:

- **The interface:** tabs, buttons, hints, notifications and dialogs.
- **Side tasks:** when Russian is selected, the model is asked to write recaps, epilogues, "What's next?" ideas, check results and generated chronicles in Russian.
- **What does not change:** the hidden guidance added to the prompt during chat stays in English. Nobody sees it, and models follow it best in English. It does not affect the language of your roleplay.

Default names for new items ("Chronicle 1", "Arc 1", "Episode 1", "First beat") are created in the selected language. Existing chronicles are left alone.

### Adding a language

Translations live in `locales/`. The English source string is the key, so anything untranslated simply shows in English.

1. Copy `locales/ru.js` to `locales/<code>.js` (for example `de.js`) and translate the values. Leave placeholders such as `{name}` as they are.
2. Register it in `i18n.js`: add the import, an entry in `DICTS` and an entry in `LANGUAGES`.

Pull requests with new translations are welcome.

## Quick start

1. Open the drawer and go to **Edit**. Create a chronicle, add an arc, an episode and a few beats.
2. Go to **Dashboard** and pick the chronicle for your chat.
3. Chat as usual. The active beat, the next beat's title, the arc summary and the pacing instruction are added to the prompt.
4. Use **Complete beat**, **Skip**, **Rewind** or **Branch** as the story moves.

Want to see a finished example first? Import `examples/example-chronicle.json` from **Worlds → Import file**.

## Concepts

| Level | What it is |
| --- | --- |
| Chronicle | Your whole campaign, with an optional linked lorebook |
| Arc | A major section with a summary and an optional pacing override |
| Episode | A group of beats inside an arc |
| Beat | One story point: description, goals, required events, and a *must* or *should* priority |

Beat states: **locked**, **active**, **completed**, **skipped**, **branched**.

A **branch** is a beat that points at another beat in the same episode and has a trigger description. From the active beat you can branch into it, and completing it returns to the main story.

## Features

- **Dashboard** with progress bars, a segmented story strip per arc and episode, and quick actions
- **Pacing**: Slow, Normal, Fast forward, with a per-arc override
- **Dynamic nudge** when the chat stalls (no extra model call)
- **Beat check**: asks a model whether the beat's events happened, then asks you to confirm
- **Arc recap**, **epilogue generator**, **What's next?**, **lore suggestions**, **continuity check** (each can be switched on or off)
- **Worlds**: link a lorebook, edit its entries, generate a chronicle from a lorebook or from a known story, import and export JSON (optionally bundling the lorebook)
- **Connection profiles**: choose which profile runs side tasks (recaps, checks, generation), refresh the list, and switch the chat profile
- **Global and per-chat on/off**, plus a movable floating button you can hide

## Notes

- **Where data lives:** chronicles and settings are stored in SillyTavern's extension settings. Per-chat progress is stored in that chat's metadata.
- **Side tasks and profiles:** side tasks use the Connection Manager's request service when it is available. Otherwise they use your current connection.
- **Generated chronicles are drafts.** Models can get story details wrong. Review before you use them.
- **Continuity check** is manual for now. It checks the last few messages against completed beats and the linked lorebook.

## Chronicle JSON format

```json
{
  "format": "chronicle-engine",
  "version": 1,
  "chronicle": {
    "title": "",
    "description": "",
    "lorebook": "",
    "characters": [],
    "arcs": [
      {
        "title": "",
        "summary": "",
        "pacing": "slow | normal | fast | empty",
        "episodes": [
          {
            "title": "",
            "beats": [
              {
                "id": "optional, used to link branches",
                "title": "",
                "description": "",
                "goals": [],
                "requiredEvents": [],
                "priority": "must | should",
                "branchOf": "id or title of a beat in the same episode",
                "branchTrigger": ""
              }
            ]
          }
        ]
      }
    ]
  },
  "lorebook": { "name": "", "data": {} }
}
```

The top-level `lorebook` block is optional and is written when you export with "Include the lorebook".

## License

MIT
