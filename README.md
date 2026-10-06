# MediaFire Folder Grabber

A small local web tool that lists every file in a public MediaFire folder (including subfolders) and downloads them all in one click. It can save straight to a folder on your computer, so your browser never asks where to save each file.

## Requirements

- [Node.js](https://nodejs.org) 18 or newer (no packages to install)

## Run it

**Windows:** double-click `start.bat`.

**Any system:**

```bash
node server.js
```

Then open http://localhost:3000.

## Use it

1. Paste a public MediaFire folder link, for example `https://www.mediafire.com/folder/abc123xyz/MyFolder`.
2. Click **Load files**.
3. Untick anything you don't want.
4. Leave **Save directly** ticked to save into the folder shown (default: `Downloads/MediaFire`), or untick it to use normal browser downloads.
5. Click **Download all**.

## Notes

- Works with public folders only. Password-protected or removed files are skipped and show a ✗.
- The server only listens on `127.0.0.1`, so it is reachable from your own computer only.
- Set a different port with the `PORT` environment variable.
- Only download files you have the right to download. This tool is not affiliated with MediaFire.

## How it works

The server reads the folder through MediaFire's public API, finds each file's direct link, and streams the file to disk (or to your browser). A small server is needed because MediaFire blocks direct requests from web pages.
