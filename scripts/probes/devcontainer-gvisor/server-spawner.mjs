import process from 'node:process';
import { defaultDevcontainerBuildSpawner } from '../../../packages/server/dist/provisioner.js';
const [, , workspaceFolder, imageName] = process.argv;
try {
  const result = await defaultDevcontainerBuildSpawner({
    workspaceFolder,
    imageName,
    dockerHost: 'unix:///var/run/docker.sock',
    noCache: true,
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
} catch (error) {
  process.stderr.write(String(error));
  process.exitCode = 1;
}
