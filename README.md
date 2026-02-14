# XRay Viewer

A Thymer plugin that lets you inspect and duplicate records. View the full structure of a record or copy it (including contents and backreferences) into a new record in the same collection.

## Features

### Record Structure View

Visualize all elements in the current record as a tree. Shows:

- **Element hierarchy** – tasks, text, headings, lists, quotes, images, files, and more
- **Preview snippets** – short text previews for each element
- **Backreferences** – records that link to the current record (click to navigate)

**How to use:**

- **Sidebar** – click "Record structure"
- **Command palette** – "XRay Viewer: Show record structure"

### Record Structure Copy

Create a full copy of the active record in the same collection. The new record includes:

- All properties
- The full body tree (line items, hierarchy)
- A header noting the source record
- Backreferences

**How to use:**

- **Command palette** – "XRay Viewer: Record structure copy"

## Requirements

- Thymer with plugin support
- An open record (for both features)
- For copy: an active collection

## Installation

Install the plugin via your Thymer workspace plugin management. The plugin consists of `plugin.js` and `plugin.json`.
