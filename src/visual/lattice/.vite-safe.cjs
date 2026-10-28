const childProcess = require("node:child_process");

childProcess.exec = () => ({
  on() {
    return this;
  },
  kill() {},
});
childProcess.execFile = childProcess.exec;
