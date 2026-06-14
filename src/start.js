/**
 * Process manager — starts both the HTTP API and the BullMQ worker.
 * Using Node spawn instead of shell & so crashes are visible and
 * Railway's port health check sees the API bind immediately.
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

function run(script) {
  const child = spawn('node', [join(__dirname, script)], {
    stdio: 'inherit',
    env: process.env,
  })

  child.on('error', (err) => {
    console.error(`[start] Failed to start ${script}:`, err.message)
  })

  child.on('exit', (code, signal) => {
    console.error(`[start] ${script} exited (code=${code} signal=${signal}) — restarting in 3s`)
    setTimeout(() => run(script), 3000)
  })

  return child
}

// API must bind the port first — Railway health check hits within seconds
run('api.js')

// Worker starts 2s later to avoid competing for startup resources
setTimeout(() => run('queue/worker.js'), 2000)
