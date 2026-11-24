/** The file name of a native executable on a platform: Windows adds `.exe`. */
export const executableFileName = (name, platform) => (platform === 'win32' ? `${name}.exe` : name);
