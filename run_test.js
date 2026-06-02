// Since no unit test suite exists, let's write a script to check if the app starts.
const http = require('http');
const { exec } = require('child_process');

console.log("Starting server...");
const serverProcess = exec('npm run start', { cwd: 'health-hub-backend' });

setTimeout(() => {
    http.get('http://localhost:3000/health', (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
            console.log("Health check response:", data);
            serverProcess.kill();
            process.exit(res.statusCode === 200 ? 0 : 1);
        });
    }).on('error', (e) => {
        console.error("Health check failed:", e.message);
        serverProcess.kill();
        process.exit(1);
    });
}, 5000); // Give server 5 seconds to boot
