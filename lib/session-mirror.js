// Every desktop app connected to a server shows every session, so two people
// can share it at once (who types is decided per tab, lib/tab-owners.js).
// The server announces each change with the full session list; an app opens
// a tab for each session it neither opened itself nor already shows, and
// leaves alone the ones its user closed.

/**
 * Sessions this app should open a tab for.
 * @param {Array<{id:number, instance?:string|null}>} sessions  from the server
 * @param {{ instance:string, shown:Set<number>, dismissed:Set<number> }} mine
 */
function sessionsToAdopt(sessions, { instance, shown, dismissed }) {
  return sessions.filter((s) => s.instance !== instance && !shown.has(s.id) && !dismissed.has(s.id));
}

module.exports = { sessionsToAdopt };
