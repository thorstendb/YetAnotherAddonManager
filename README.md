# YAAM – Yet Another Addon Manager

A desktop addon manager for **Elder Scrolls Online** (ESO). Scans your local addon folder, connects to the ESOUI catalog, and keeps everything up to date.

## Features

### Local Addon Management
- Automatically scans and parses ESO addon manifests (`.txt` / `.addon`)
- Detects bundled sub-addons and libraries
- Tracks mandatory and optional dependencies between addons
- Smart version detection — handles semver, date-based versions, revision suffixes, and broken or changed versioning schemes
- Discovers SavedVariables files and maps them to their owning addon via longest-prefix matching (prevents misattribution)

### ESOUI Online Catalog
- Browse and search the full ESOUI addon catalog (~10 000+ addons)
- One-click install with automatic download and extraction
- Update detection — compares local versions against ESOUI versions, even when authors change versioning schemes between releases
- Batch "Update All" with parallel downloads and progress tracking
- Automatically identifies and installs missing dependencies from the catalog

### Import & Export
- Export your complete addon setup as a single portable JSON file (addon list, AddOnSettings, UserSettings, SavedVariables)
- Selective export and import — toggle individual SavedVariables files, settings, and user preferences
- Auto-installs missing addons from the catalog when importing a profile
- Pre-import backup of all existing files

### Settings & Per-Character Configuration
- Read and modify `AddOnSettings.txt` (per-character enable/disable)
- Batch enable or disable multiple addons at once
- Automatic backup before every change, with undo support
- Write verification after every save — on failure the backup is automatically restored

### Backup & Restore
- Automatic addon backup before every update, delete, or cleanup
- SavedVariables backups preserved separately, tagged by operation type
- Point-in-time snapshots with visual diff display (added / removed / version-changed)
- Three-tab restore dialog: Addon Backups · Snapshots · SavedVariables
- Granular delete options: delete only addon, delete + SavedVariables, delete + exclusive dependencies, or all combined

### Cleanup Tools
- Find and remove unused libraries (multi-pass dependency analysis with reference counting)
- Exclusive dependency cleanup — deleting an addon only removes libraries that no other addon references
- Clean up orphaned settings and SavedVariables for uninstalled addons
- Inline undo after every cleanup operation (restores settings and SavedVariables from backup)
- Move stray `.zip` archives out of the AddOns folder

### User Interface
- Three resizable panels: AddOns tree, Libraries tree, ESOUI Browser
- Search and filter per panel (including per-character filtering)
- Keyboard navigation (arrow keys, Enter, Escape)
- Right-click context menus, image lightbox, copy-to-clipboard log
- Dark and light theme with one-click toggle

## Getting Started

### Prerequisites
- [Node.js](https://nodejs.org/) (v18+)
- [Yarn](https://yarnpkg.com/)

### Install & Run
```bash
yarn install
yarn dev        # Development mode with hot-reload
yarn start      # Build + launch Electron
```

### Build Distributable
```bash
yarn dist           # Windows (NSIS installer + portable)
yarn dist:mac       # macOS
yarn dist:linux     # Linux
```

## License

This project is licensed under the [MIT License](LICENSE).

## Trademark Notice

"The Elder Scrolls", "Elder Scrolls Online", "ESO", and "ZeniMax" are trademarks or registered trademarks of ZeniMax Media Inc. This project is not affiliated with, endorsed by, or sponsored by ZeniMax Media Inc. or any of its subsidiaries.
