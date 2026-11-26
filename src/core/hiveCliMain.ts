/**
 * The `hive` command's entry point: runs runHiveCli with this process's arguments and environment.
 * Built into a self-contained bundle (see electron.vite.config.ts) that agents run through the hive's
 * bin/hive launcher.
 */
import { runHiveCli } from './hiveCli';

process.exitCode = runHiveCli(process.argv.slice(2), process.env, {
  stdout: (text) => { process.stdout.write(text); },
  stderr: (text) => { process.stderr.write(text); }
});
