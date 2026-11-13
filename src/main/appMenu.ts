import type { MenuItemConstructorOptions } from 'electron';
import { PRODUCT_NAME } from '../shared/productName';

/**
 * The application menu, for either window mode.
 *
 * It is installed whether or not multiple floors are enabled. Electron's default
 * menu names the macOS app menu and its About, Hide and Quit items from app.name,
 * which stays the package name so the settings folder and the keychain entry
 * safeStorage uses do not move; only this template spells the displayed name
 * out. `newFloor` is the File menu's New Floor item, passed only when multiple
 * floors are enabled.
 */
export function appMenuTemplate(isMac: boolean, newFloor: MenuItemConstructorOptions | null): MenuItemConstructorOptions[] {
  return [
    // The stock app menu labels its items with app.name, which stays the package
    // name so the settings folder and the keychain entry do not move; spell the
    // displayed name out instead.
    ...(isMac ? [{
      label: PRODUCT_NAME,
      submenu: [
        { role: 'about' as const, label: `About ${PRODUCT_NAME}` },
        { type: 'separator' as const },
        { role: 'services' as const },
        { type: 'separator' as const },
        { role: 'hide' as const, label: `Hide ${PRODUCT_NAME}` },
        { role: 'hideOthers' as const },
        { role: 'unhide' as const },
        { type: 'separator' as const },
        { role: 'quit' as const, label: `Quit ${PRODUCT_NAME}` }
      ]
    }] : []),
    {
      label: 'File',
      submenu: [
        ...(newFloor ? [newFloor, { type: 'separator' as const }] : []),
        isMac ? { role: 'close' as const } : { role: 'quit' as const }
      ]
    },
    // The Edit menu is spelled out rather than `{ role: 'editMenu' }` for one
    // reason: `registerAccelerator: false` on the clipboard items.
    //
    // A registered accelerator is claimed by the MENU, which then replays the
    // action through `webContents.paste()` — an async hop that runs a beat after
    // the keystroke. Dictation tools (Muesli, Wispr Flow, …) insert text by
    // stashing the clipboard, writing the transcript, sending the paste key, and
    // restoring the old clipboard immediately; the menu's late paste therefore
    // read the RESTORED clipboard and typed the user's previous copy instead of
    // what they had just said. It hit the terminal and the composer alike,
    // because both were downstream of the same replay.
    //
    // With registerAccelerator false the item still shows its shortcut, but the
    // key is left for the focused element to handle inline — xterm's own paste
    // handler and the textarea's native paste event both read the clipboard
    // synchronously, inside the keystroke, before any restore can land.
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' as const, registerAccelerator: false },
        { role: 'redo' as const, registerAccelerator: false },
        { type: 'separator' as const },
        { role: 'cut' as const, registerAccelerator: false },
        { role: 'copy' as const, registerAccelerator: false },
        { role: 'paste' as const, registerAccelerator: false },
        { role: 'selectAll' as const, registerAccelerator: false }
      ]
    },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ];
}
