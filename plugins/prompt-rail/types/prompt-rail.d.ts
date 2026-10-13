declare module 'claude-code' {
  interface PluginState {
    // Bumped when the rail's list or browsing changes; the rail reads it while
    // drawing, so a bump draws it again, and it alone.
    'prompt-rail': { moved: number }
  }
}
