// agents/chloroform.mjs — the anesthetic
//
// A watchdog with one job: if the beacon loop stops breathing (hung
// task, dead socket, blocked event loop), put the node under.
// Everything that lives inside the loop pats the watchdog.

let timer = null;

export const chloroform = {
  arm(ms) {
    this.disarm();
    timer = setTimeout(() => process.exit(201), ms);
    if (typeof timer.unref === "function") timer.unref();
  },

  pat() {
    if (timer && typeof timer.refresh === "function") timer.refresh();
  },

  disarm() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  },
};
