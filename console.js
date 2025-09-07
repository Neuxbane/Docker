#!/usr/bin/env node

/**
 * Docker Console Management Server
 *
 * SECURITY NOTES:
 * - Set ADMIN_PASSWORD environment variable with a strong password
 * - Configure ALLOWED_ORIGINS for CORS if needed
 * - Enable HTTPS in production with proper SSL certificates
 * - Run with minimal privileges (not root) in production
 * - Regularly update dependencies for security patches
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import YAML from 'yaml';
import express from 'express';
import cors from 'cors';
import { execFile } from 'child_process';


// Configuration
const SCAN_INTERVAL_MS = 5000;
const WORKSPACE_ROOT = process.cwd(); // assume started in repo root (/root/Docker)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read network base from createNetwork.sh
function getNetworkConfig() {
	try {
		const script = fs.readFileSync(path.join(WORKSPACE_ROOT, 'core', '2. setup', 'createNetwork.sh'), 'utf8');
		const subnetMatch = script.match(/--subnet=([0-9.]+\/[0-9]+)/);
		const gatewayMatch = script.match(/--gateway=([0-9.]+)/);
		const subnet = subnetMatch ? subnetMatch[1] : '172.28.0.0/16';
		const base = subnet.split('.')[0] + '.' + subnet.split('.')[1] + '.' + subnet.split('.')[2] + '.';
		const gateway = gatewayMatch ? gatewayMatch[1] : base + '1';
		return { subnet, base, gateway };
	} catch (e) {
		return { subnet: '172.28.0.0/16', base: '172.28.0.', gateway: '172.28.0.1' };
	}
}

const NETWORK = getNetworkConfig();

function log(...args) {
	console.log(new Date().toISOString(), ...args);
}

// Security utilities
function sanitizePath(inputPath) {
	if (!inputPath || typeof inputPath !== 'string') return null;
	
	// Resolve the path and check if it's within the workspace
	const resolved = path.resolve(WORKSPACE_ROOT, inputPath);
	const relative = path.relative(WORKSPACE_ROOT, resolved);
	
	// Prevent directory traversal
	if (relative.startsWith('..') || path.isAbsolute(relative)) {
		return null;
	}
	
	return resolved;
}

function validateServiceName(name) {
	if (!name || typeof name !== 'string') return false;
	// Allow alphanumeric, hyphens, underscores, max 50 chars
	return /^[a-zA-Z0-9_-]{1,50}$/.test(name);
}

function validateProjectName(name) {
	if (!name || typeof name !== 'string') return false;
	// Allow alphanumeric, hyphens, underscores, dots, max 100 chars
	return /^[a-zA-Z0-9_.-]{1,100}$/.test(name);
}

function safeExecFile(cmd, args, options = {}) {
	// Ensure command is in PATH or absolute
	const allowedCommands = ['docker', 'docker-compose', 'nginx', 'systemctl'];
	if (!allowedCommands.includes(path.basename(cmd))) {
		throw new Error('Command not allowed');
	}
	
	return new Promise((resolve, reject) => {
		execFile(cmd, args, options, (err, stdout, stderr) => {
			if (err) reject(err);
			else resolve({ stdout, stderr });
		});
	});
}

// Utility: recursively find candidate project folders containing docker-compose.yml and scripts
async function findProjectDirs(root) {
	const results = [];
	const entries = await fs.promises.readdir(root, { withFileTypes: true });
	for (const ent of entries) {
		const full = path.join(root, ent.name);
		if (ent.isDirectory()) {
			// skip node_modules and .git
			if (ent.name === 'node_modules' || ent.name === '.git') continue;
			try {
				const files = await fs.promises.readdir(full);
				if (['docker-compose.yml', 'connect.sh', 'restart.sh', 'stop.sh'].every(f => files.includes(f))) {
					results.push(full);
				} else {
					const child = await findProjectDirs(full);
					results.push(...child);
				}
			} catch (err) {
				// ignore permission errors
			}
		}
	}
	return results;
}

// parse docker-compose.yml and return JS object
function parseCompose(content) {
	return YAML.parse(content);
}

// stringify and write compose back
function writeCompose(filePath, obj) {
	const yamlText = YAML.stringify(obj);
	try {
		if (fs.existsSync(filePath)) {
			const cur = fs.readFileSync(filePath, 'utf8');
			if (cur === yamlText) return false; // no change
		}
		// sanitize ports: convert any port objects to strings (skip unknown objects)
		try {
			if (obj && obj.services) {
				for (const [sname, svc] of Object.entries(obj.services)) {
					if (svc && svc.ports && Array.isArray(svc.ports)) {
						const cleaned = [];
						for (const p of svc.ports) {
							if (typeof p === 'string') { cleaned.push(p); continue; }
							if (p && typeof p === 'object') {
								const container = (p.container || p.target || p.to || p.published || p.exposed || '').toString();
								const host = p.host || p.published || p.published_port || null;
								const bind = p.bind || p.address || null;
								if (container) {
									if (bind && host) cleaned.push(`${bind}:${host}:${container}`);
									else if (host) cleaned.push(`${host}:${container}`);
									else cleaned.push(`${container}`);
									continue;
								}
							}
							// unknown port entry - skip it to avoid writing [object Object]
						}
						svc.ports = cleaned;
					}
					// normalize networks: if a network value is a plain ip string, convert to { ipv4_address }
					if (svc && svc.networks && typeof svc.networks === 'object') {
						for (const [nk, nv] of Object.entries(svc.networks)) {
							if (typeof nv === 'string' && nv.trim() !== '' && /^\d+\.\d+\.\d+\.\d+$/.test(nv.trim())) {
								svc.networks[nk] = { ipv4_address: nv.trim() };
							}
						}
					}
				}
			}
		} catch (e) {
			// ignore sanitize errors
		}
		const finalYaml = YAML.stringify(obj);
		fs.writeFileSync(filePath, finalYaml, 'utf8');
		return true;
	} catch (e) {
		throw e;
	}
}

// read createNetwork.sh to derive base network (fallback to NETWORK_BASE)
function readNetworkBase() {
	try {
		const s = fs.readFileSync(path.join(WORKSPACE_ROOT, 'core', '2. setup', 'createNetwork.sh'), 'utf8');
		const m = s.match(/--subnet=([0-9.]+\.[0-9]+\.[0-9]+\.[0-9]+\/[0-9]+)/);
		if (m) return m[1];
	} catch (e) {}
	return NETWORK_CIDR;
}

// Simple port allocation: collect all host ports in use and pick next free
function allocatePorts(existingHostPorts, requested) {
	// requested can be a single port or a range mapping like "8080:80" or ["8080:80","...]
	// We'll only change the host port (left side of colon) when conflict detected.
	const used = new Set(existingHostPorts);
	const allocations = {};
	let probe = 10000; // start trying from 10000
	for (const key of Object.keys(requested)) {
		const val = requested[key];
		// val can be a string "8080:80" or number or object; handle common forms
		let hostPort = null;
		if (typeof val === 'string') {
			const parts = val.split(':');
			hostPort = parseInt(parts[0], 10);
		} else if (typeof val === 'number') {
			hostPort = val;
		}
		if (!hostPort || isNaN(hostPort)) continue;
		if (!used.has(hostPort)) {
			used.add(hostPort);
			allocations[key] = hostPort; // keep same
			continue;
		}
		// find next free
		while (used.has(probe)) probe++;
		allocations[key] = probe;
		used.add(probe);
		probe++;
	}
	return allocations;
}

// Allocate IPs from network base, avoid conflicts
function allocateIps(existingIps, count) {
	const used = new Set(existingIps.map(ip => ip.split('.').slice(-1)[0]));
	const ips = [];
	for (let i = 2; i < 255 && ips.length < count; i++) {
		if (!used.has(String(i))) ips.push(NETWORK.base + i);
	}
	return ips;
}

// Scan projects, collect used host ports and assigned container IPs, then resolve conflicts
async function scanAndFix() {
	log('scan start');
	const projectDirs = await findProjectDirs(WORKSPACE_ROOT);
	const mapper = {};

	// gather global used host ports and ips (counts)
	const usedHostCounts = Object.create(null); // port -> count
	const usedIpCounts = Object.create(null); // ip -> count
	const usedHostSet = new Set(); // quick lookup for allocation

	// first pass: parse all compose files and collect used host ports and static ips (counts)
	const composeData = [];
	for (const dir of projectDirs) {
		const file = path.join(dir, 'docker-compose.yml');
		try {
			const content = fs.readFileSync(file, 'utf8');
			const obj = parseCompose(content) || {};
			const services = obj.services || {};
			// collect networks referenced by services so we can ensure top-level networks block includes them
			const usedNets = new Set();
			for (const [name, svc] of Object.entries(services)) {
						if (svc && svc.networks && typeof svc.networks === 'object') {
							for (const nn of Object.keys(svc.networks)) usedNets.add(nn);
						}
				if (svc.ports) {
					for (const p of svc.ports) {
						const parts = String(p).split(':');
						const host = parts.length === 3 ? parseInt(parts[1], 10) : parseInt(parts[0], 10);
						if (!isNaN(host)) {
							usedHostCounts[host] = (usedHostCounts[host] || 0) + 1;
							usedHostSet.add(host);
						}
					}
				}
				if (svc.networks) {
					for (const netName of Object.keys(svc.networks)) {
						const net = svc.networks[netName];
						// network can be an object with ipv4_address, or a plain string containing the address
						if (typeof net === 'string') {
							const ip = net.trim();
							if (isIpv4(ip)) usedIpCounts[ip] = (usedIpCounts[ip] || 0) + 1;
						} else {
							if (net && net.ipv4_address) usedIpCounts[net.ipv4_address || net.ipv4Address] = (usedIpCounts[net.ipv4_address || net.ipv4Address] || 0) + 1;
							if (net && net.ipv4Address) usedIpCounts[net.ipv4Address] = (usedIpCounts[net.ipv4Address] || 0) + 1;
						}
						if (svc.ipv4_address) usedIpCounts[svc.ipv4_address] = (usedIpCounts[svc.ipv4_address] || 0) + 1;
						if (svc.ipv4Address) usedIpCounts[svc.ipv4Address] = (usedIpCounts[svc.ipv4Address] || 0) + 1;
					}
				}
				if (svc.ipv4_address) usedIpCounts[svc.ipv4_address] = (usedIpCounts[svc.ipv4_address] || 0) + 1;
				if (svc.ipv4Address) usedIpCounts[svc.ipv4Address] = (usedIpCounts[svc.ipv4Address] || 0) + 1;
			}
			composeData.push({ dir, file, obj, usedNets: Array.from(usedNets) });
		} catch (e) {
			log('failed parse', file, e.message);
		}
	}

	// deterministic ordering to avoid allocation oscillation
	composeData.sort((a, b) => a.dir.localeCompare(b.dir));

	// second pass: fix conflicts and write files
	for (const item of composeData) {
		const { dir, file, obj } = item;
		const services = obj.services || {};
		const serviceMapper = {};

		for (const [name, svc] of Object.entries(services)) {
			// copy full service definition so UI can display image/volumes/env
			try {
				serviceMapper[name] = JSON.parse(JSON.stringify(svc || {}));
			} catch (e) {
				serviceMapper[name] = Object.assign({}, svc || {});
			}
			serviceMapper[name].ports = serviceMapper[name].ports || [];
			// fix ports
			if (svc.ports) {
				let idx = 0;
				const newPorts = [];
				for (const p of svc.ports) {
					let original = String(p);
					if (typeof p === 'string') {
						const parts = original.split(':');
						if (parts.length === 3) {
							// host:container form with ip
							const hostPortIndex = 1;
							const hostPort = parseInt(parts[hostPortIndex], 10);
							// only reassign if this port is duplicated elsewhere
							if (!isNaN(hostPort) && (usedHostCounts[hostPort] || 0) > 1) {
								// find next free probe port
								let probe = 10000;
								while (usedHostSet.has(probe)) probe++;
								const newHost = probe;
								newPorts.push(`${parts[0]}:${newHost}:${parts[2]}`);
								usedHostSet.add(newHost);
								usedHostCounts[hostPort] = (usedHostCounts[hostPort] || 1) - 1;
							} else {
								newPorts.push(original);
							}
						} else if (parts.length === 2) {
							const hostPort = parseInt(parts[0], 10);
							if (!isNaN(hostPort) && (usedHostCounts[hostPort] || 0) > 1) {
								let probe = 10000;
								while (usedHostSet.has(probe)) probe++;
								const newHost = probe;
								newPorts.push(`${newHost}:${parts[1]}`);
								usedHostSet.add(newHost);
								usedHostCounts[hostPort] = (usedHostCounts[hostPort] || 1) - 1;
							} else {
								newPorts.push(original);
							}
						} else {
							newPorts.push(original);
						}
					} else {
						newPorts.push(original);
					}
					serviceMapper[name].ports.push(newPorts[newPorts.length-1]);
					idx++;
				}
				svc.ports = newPorts;
				// update mapper copy with normalized ports
				try { serviceMapper[name].ports = JSON.parse(JSON.stringify(newPorts)); } catch(e) { serviceMapper[name].ports = newPorts.slice(); }
			}

			// fix static IPs in networks if present
			if (svc.networks) {
				for (const netName of Object.keys(svc.networks)) {
					const net = svc.networks[netName];
					// normalize plain-string network entries (e.g., neuxbane-core-net: 172.28.0.3)
					if (typeof net === 'string') {
						const ip = net.trim();
						if (isIpv4(ip)) {
							// only reassign if ip is duplicated elsewhere
							if ((usedIpCounts[ip] || 0) > 1) {
								const newIp = allocateIps(Object.keys(usedIpCounts), 1)[0];
								if (newIp) {
									svc.networks[netName] = { ipv4_address: newIp };
									usedIpCounts[ip] = (usedIpCounts[ip] || 1) - 1;
									usedIpCounts[newIp] = (usedIpCounts[newIp] || 0) + 1;
									serviceMapper[name].networks[netName] = newIp;
								}
							} else {
								// normalize to object form to avoid oscillation
								svc.networks[netName] = { ipv4_address: ip };
								serviceMapper[name].networks[netName] = ip;
							}
						} else {
							// non-ip string (e.g., just network name); record as-is
							serviceMapper[name].networks[netName] = net;
						}
						continue;
					}

					if (net && net.ipv4_address) {
						const cur = net.ipv4_address || net.ipv4Address;
						if (cur && (usedIpCounts[cur] || 0) > 1) {
							const newIp = allocateIps(Object.keys(usedIpCounts), 1)[0];
							if (newIp) {
								if (net.ipv4_address !== newIp) {
									svc.networks[netName].ipv4_address = newIp;
								}
								usedIpCounts[newIp] = (usedIpCounts[newIp] || 0) + 1;
								serviceMapper[name].networks[netName] = newIp;
							}
						} else if (cur) {
							serviceMapper[name].networks[netName] = cur;
						}
					} else if (net && net.ipv4Address) {
						const cur = net.ipv4Address;
						if ((usedIpCounts[cur] || 0) > 1) {
							const newIp = allocateIps(Object.keys(usedIpCounts), 1)[0];
							if (newIp) {
								if (net.ipv4Address !== newIp) {
									svc.networks[netName].ipv4Address = newIp;
								}
								usedIpCounts[newIp] = (usedIpCounts[newIp] || 0) + 1;
								serviceMapper[name].networks[netName] = newIp;
							}
						} else {
							serviceMapper[name].networks[netName] = cur;
						}

						// after normalizing ports/networks, update mapper entry to reflect final service definition
						try { serviceMapper[name] = JSON.parse(JSON.stringify(svc)); } catch(e) { serviceMapper[name] = Object.assign({}, svc); }
					}
				}
			}
		}

				// set networks default to the neuxbane-core-net if networks top-level missing
				if (!obj.networks) obj.networks = { 'neuxbane-core-net': { external: true } };

						// Ensure any networks referenced by services are present in top-level `networks`.
						// If a referenced network is missing, add a minimal empty definition so compose remains valid.
						try {
							const fileUsedNets = new Set(item.usedNets || []);
										for (const netName of Array.from(fileUsedNets)) {
											if (!obj.networks[netName]) {
												// preserve the common special case for neuxbane-core-net (external network)
												// For any other networks referenced by services, default to external:true and set name
												obj.networks[netName] = { external: true, name: netName };
											}
										}
						} catch (e) {
							// ignore network augmentation errors
						}

						// Prune unused top-level networks: remove any network that is not referenced by
						// services in this compose file. Keep `neuxbane-core-net` as a special-case default.
						try {
							const fileUsedNets = new Set(item.usedNets || []);
							if (obj.networks && typeof obj.networks === 'object') {
								for (const existing of Object.keys(Object.assign({}, obj.networks))) {
									if (!fileUsedNets.has(existing) && existing !== 'neuxbane-core-net') {
										delete obj.networks[existing];
									}
								}
								// if networks object is now empty, remove it entirely
								if (Object.keys(obj.networks).length === 0) delete obj.networks;
							}
						} catch (e) {
							// ignore pruning errors
						}

		// write back compose only if changed
		try {
			writeCompose(file, obj);
			mapper[dir] = { file, services: serviceMapper };
			log('updated', file);
		} catch (e) {
			log('write failed', file, e.message);
		}
	}

	// remove legacy mapper.js if present (to avoid confusion), then write mapper.json next to console.js
	try {
		const legacy = path.join(__dirname, 'mapper.js');
		if (fs.existsSync(legacy)) fs.unlinkSync(legacy);
	} catch (e) {
		// ignore
	}
	try {
		const mapperFile = path.join(__dirname, 'mapper.json');
		const content = JSON.stringify(mapper, null, 2) + '\n';
		if (fs.existsSync(mapperFile)) {
			const cur = fs.readFileSync(mapperFile, 'utf8');
			if (cur !== content) fs.writeFileSync(mapperFile, content, 'utf8');
		} else {
			fs.writeFileSync(mapperFile, content, 'utf8');
		}
		log('wrote mapper.json');
	} catch (e) {
		log('failed write mapper.json', e.message);
	}

	log('scan done');
}

// periodic runner
async function runner() {
	try {
		// If there are active terminal sessions, skip scanning to avoid restarting containers
		if (typeof globalThis.activeTerminalCount === 'number' && globalThis.activeTerminalCount > 0) {
			log('skipping scan because activeTerminalCount=' + globalThis.activeTerminalCount);
			return;
		}
		await scanAndFix();
	} catch (e) {
		log('scan error', e && e.stack ? e.stack : e);
	}
}

// start interval
log('starting scanner every', SCAN_INTERVAL_MS, 'ms');
// start interval
log('starting scanner every', SCAN_INTERVAL_MS, 'ms');
// --- HTTP UI / API ---
const app = express();
// Security middleware
app.use(cors({
	origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : ['http://localhost:3000', 'http://127.0.0.1:3000'],
	credentials: true,
	methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
	allowedHeaders: ['Content-Type', 'Authorization']
}));

// Security headers
app.use((req, res, next) => {
	res.setHeader('X-Content-Type-Options', 'nosniff');
	res.setHeader('X-Frame-Options', 'DENY');
	res.setHeader('X-XSS-Protection', '1; mode=block');
	res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
	// Note: allowing 'unsafe-inline' for styles is a pragmatic choice for the local UI (Babel/React/xterm
	// inject inline styles). Consider replacing with nonces or hashes for production.
	res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://unpkg.com https://cdn.tailwindcss.com https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://fonts.googleapis.com https://cdn.jsdelivr.net; style-src-elem 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdn.tailwindcss.com https://fonts.googleapis.com; style-src-attr 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdn.tailwindcss.com https://fonts.googleapis.com; img-src 'self' data: https:; font-src 'self' https://fonts.gstatic.com; connect-src 'self' https://unpkg.com ws: wss:; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self';");
	next();
});
app.use(express.json());

// transient status map for in-progress operations: { [projectPath]: { [service]: 'restarting'|'stopping' } }
const transientStatus = {};

// serve UI, including .jsx files for Babel
app.use('/', express.static(path.join(__dirname, 'ui/console'), {
	setHeaders: (res, filePath) => {
		if (filePath.endsWith('.jsx')) {
			// serve .jsx with text/jsx so the client can process it via Babel/ESM loader
			res.setHeader('Content-Type', 'text/jsx');
		}
	}
}));

// Handle favicon.ico requests
app.get('/favicon.ico', (req, res) => {
	res.status(204).end(); // No Content - browsers will use default favicon
});

// helper to load mapper from mapper.json or mapper.js (legacy)
function readMapperFile() {
	const jsonPath = path.join(__dirname, 'mapper.json');
	const jsPath = path.join(__dirname, 'mapper.js');
	try {
		if (fs.existsSync(jsonPath)) {
			const raw = fs.readFileSync(jsonPath, 'utf8');
			return JSON.parse(raw);
		}
		if (fs.existsSync(jsPath)) {
			const raw = fs.readFileSync(jsPath, 'utf8');
			const stripped = raw.replace(/^\s*export\s+default\s+/, '');
			return JSON.parse(stripped);
		}
	} catch (e) {
		log('readMapperFile failed', e && e.message ? e.message : e);
	}
	return null;
}

// GET mapper
app.get('/api/mapper', async (req, res) => {
	try {
		let m = readMapperFile();
		if (!m) {
			await scanAndFix();
			m = readMapperFile() || {};
		}
		// enrich mapper with live status per service and return status as single string
		const enriched = JSON.parse(JSON.stringify(m));
		for (const [proj, info] of Object.entries(enriched)){
			const composeFile = info.file;
			// default statuses
			for (const svc of Object.keys(info.services||{})){
				info.services[svc].status = 'unknown';
			}
			try {
				// use unique project name to avoid conflicts
				const safeName = path.basename(proj).replace(/[^A-Za-z0-9]/g, '').toLowerCase() || 'project';
				const execEnv = Object.assign({}, process.env, { COMPOSE_PROJECT_NAME: safeName });
				const r = await runCompose(composeFile, ['ps', '--services', '--filter', 'status=running'], 10000, execEnv);
				const running = (r.stdout||'').split('\n').map(s=>s.trim()).filter(Boolean);
				for (const svc of Object.keys(info.services||{})){
					info.services[svc].status = running.includes(svc) ? 'running' : 'stopped';
				}
			} catch (e) {
				// ignore ps failures, leave as 'unknown'
			}
			// merge transient flags (overrides running/stopped)
			const tproj = transientStatus[proj] || {};
			for (const [svc, t] of Object.entries(tproj)){
				if (info.services[svc]) info.services[svc].status = t; // e.g. 'restarting' or 'stopping'
			}
		}
		res.json(enriched);
	} catch (e) {
		res.status(500).json({ error: String(e) });
	}
});

// GET next free IP on neuxbane-core-net
app.get('/api/next-ip', async (req, res) => {
	try {
		const usedIPs = new Set();
	const requestedNetwork = String(req.query.network || '').trim();
		// scan compose files for network ips
		try {
			const all = await findProjectDirs(WORKSPACE_ROOT);
			for (const d of all) {
				const f = path.join(d, 'docker-compose.yml');
				try {
					const c = fs.readFileSync(f, 'utf8');
					const o = parseCompose(c) || {};
					for (const s of Object.values(o.services || {})) {
						if (s.networks) for (const n of Object.values(s.networks || {})) {
							if (typeof n === 'string' && /^\d+\.\d+\.\d+\.\d+$/.test(n)) usedIPs.add(n.trim());
							else if (n && typeof n === 'object' && (n.ipv4_address || n.ipv4Address)) usedIPs.add((n.ipv4_address || n.ipv4Address));
						}
						if (s.ipv4_address) usedIPs.add(s.ipv4_address);
						if (s.ipv4Address) usedIPs.add(s.ipv4Address);
					}
				} catch (e) {}
			}
		} catch (e) {}

			// also inspect current docker network containers for the requested network if docker available
			let networkBase = NETWORK.base; // default fallback
			try {
				// if a specific network requested, inspect it to obtain subnet/gateway
				const inspectTarget = requestedNetwork || 'neuxbane-core-net';
				const { stdout } = await new Promise((resolve, reject) => {
					execFile('docker', ['network', 'inspect', inspectTarget], (error, stdout, stderr) => {
						if (error) return reject(error);
						resolve({ stdout, stderr });
					});
				});
				const netInfo = JSON.parse(stdout)[0] || {};
				// try to derive base from IPAM.Config[0].Subnet e.g. '172.28.0.0/16' -> '172.28.0.'
				try {
					const cfg = (netInfo.IPAM && netInfo.IPAM.Config && netInfo.IPAM.Config[0]) || {};
					const subnet = cfg.Subnet || cfg.subnet || '';
					if (subnet && subnet.indexOf('/') !== -1) {
						const prefix = subnet.split('/')[0];
						const parts = prefix.split('.');
						// use first three octets as base if /16 or /24-ish
						if (parts.length === 4) networkBase = parts.slice(0, 3).join('.') + '.';
					}
				} catch (e) {}

				for (const cont of Object.values(netInfo.Containers || {})) {
					if (cont && cont.IPv4Address) {
						const ip = String(cont.IPv4Address || '').split('/')[0];
						if (ip) usedIPs.add(ip);
					}
				}
			} catch (e) {
				// ignore if docker absent or inspect failed; keep default NETWORK.base
			}

			// find next free in networkBase range (e.g., '172.28.0.')
			let nextIp = null;
			for (let i = 2; i < 255; i++) {
				const cand = networkBase + i;
				if (!usedIPs.has(cand)) { nextIp = cand; break; }
			}
		if (!nextIp) return res.status(500).json({ error: 'no free ip available' });
		res.json({ ip: nextIp });
	} catch (e) {
		res.status(500).json({ error: String(e) });
	}
});

// GET list docker networks: /api/networks
app.get('/api/networks', async (req, res) => {
	try {
		// use docker to list networks in JSON format
		const { stdout } = await new Promise((resolve, reject) => {
			execFile('docker', ['network', 'ls', '--format', '{{json .}}'], (err, stdout, stderr) => {
				if (err) return reject(err);
				resolve({ stdout, stderr });
			});
		});
		// stdout is multiple JSON objects separated by newlines
		const lines = String(stdout || '').split('\n').map(l=>l.trim()).filter(Boolean);
		const nets = lines.map(l => {
			try { return JSON.parse(l); } catch (e) { return { Name: l }; }
		});
		// enrich by inspecting each network for details (best-effort)
		const detailed = [];
		for (const n of nets) {
			try {
				const r = await new Promise((resolve, reject) => {
					execFile('docker', ['network', 'inspect', n.Name || n.ID], (err, stdout, stderr) => {
						if (err) return reject(err);
						resolve({ stdout, stderr });
					});
				});
				const info = JSON.parse(r.stdout || '[]')[0] || n;
				detailed.push(info);
			} catch (e) {
				detailed.push(n);
			}
		}
		res.json({ networks: detailed });
	} catch (e) {
		res.status(500).json({ error: String(e) });
	}
});

// POST create network: { name }
app.post('/api/networks/create', async (req, res) => {
	try {
		const name = req.body && req.body.name;
		if (!name || typeof name !== 'string') return res.status(400).json({ error: 'Missing network name' });
		// create with default driver bridge
		await new Promise((resolve, reject) => {
			execFile('docker', ['network', 'create', name], (err, stdout, stderr) => {
				if (err) return reject(formatExecError(err));
				resolve({ stdout, stderr });
			});
		});
		res.json({ ok: true });
	} catch (e) {
		res.status(500).json({ error: (e && e.error) ? e.error : String(e) });
	}
});

// POST delete network: { name }
app.post('/api/networks/delete', async (req, res) => {
	try {
		const name = req.body && req.body.name;
		if (!name || typeof name !== 'string') return res.status(400).json({ error: 'Missing network name' });
		await new Promise((resolve, reject) => {
			execFile('docker', ['network', 'rm', name], (err, stdout, stderr) => {
				if (err) return reject(formatExecError(err));
				resolve({ stdout, stderr });
			});
		});
		res.json({ ok: true });
	} catch (e) {
		res.status(500).json({ error: (e && e.error) ? e.error : String(e) });
	}
});

// POST update network: { name, ipam: { Subnet, Gateway } }
app.post('/api/networks/update', async (req, res) => {
	try {
		const body = req.body || {};
		const name = body.name;
		const ipam = body.ipam || {};
		if (!name || typeof name !== 'string') return res.status(400).json({ error: 'Missing network name' });

		// do not allow editing builtin networks
		if (['bridge','host','none'].includes(name)) return res.status(400).json({ error: 'Builtin networks cannot be edited' });

		// inspect network to see if any containers are attached
		const info = await new Promise((resolve, reject) => {
			execFile('docker', ['network', 'inspect', name], (err, stdout, stderr) => {
				if (err) return reject(formatExecError(err));
				resolve(JSON.parse(stdout || '[]')[0] || null);
			});
		});

		if (!info) return res.status(404).json({ error: 'Network not found' });

		const containers = info.Containers || info.Containers || {};
		if (containers && Object.keys(containers).length > 0) {
			return res.status(400).json({ error: 'Network has attached containers. Disconnect them first before updating.' });
		}

		// safe to recreate: remove and create with ipam settings if provided
		// remove network
		await new Promise((resolve, reject) => {
			execFile('docker', ['network', 'rm', name], (err, stdout, stderr) => {
				if (err) return reject(formatExecError(err));
				resolve({ stdout, stderr });
			});
		});

		// build create args
		const args = ['network', 'create'];
		if (ipam && (ipam.Subnet || ipam.Gateway)) {
			// construct ipam config JSON string
			const cfg = { Config: [ {} ] };
			if (ipam.Subnet) cfg.Config[0].Subnet = ipam.Subnet;
			if (ipam.Gateway) cfg.Config[0].Gateway = ipam.Gateway;
			args.push('--driver', 'bridge', '--ipam-driver', 'default', '--opt', `com.docker.network.bridge.name=${name}`);
			// Docker network create accepts --subnet/--gateway flags directly
			if (ipam.Subnet) args.push('--subnet', ipam.Subnet);
			if (ipam.Gateway) args.push('--gateway', ipam.Gateway);
		}
		args.push(name);

		await new Promise((resolve, reject) => {
			execFile('docker', args, (err, stdout, stderr) => {
				if (err) return reject(formatExecError(err));
				resolve({ stdout, stderr });
			});
		});

		res.json({ ok: true });
	} catch (e) {
		res.status(500).json({ error: (e && e.error) ? e.error : String(e) });
	}
});

// helper to run docker-compose commands safely
function runCompose(file, args, timeout = 10000, env = null) {
	return new Promise((resolve, reject) => {
		const safePath = sanitizePath(file);
		if (!safePath) {
			return reject(new Error('Invalid file path'));
		}
		
		if (!fs.existsSync(safePath)) {
			return reject(new Error('Compose file not found'));
		}
		
		// try official 'docker compose' first, then fall back to 'docker-compose'
		const tryDockerCompose = (cmd, cmdArgs, execEnv) => new Promise((res, rej) => {
			const p = execFile(cmd, cmdArgs, { timeout, env: execEnv }, (err, stdout, stderr) => {
				if (err) return rej({ err, stdout, stderr, cmd, cmdArgs });
				res({ stdout, stderr, cmd, cmdArgs });
			});
		});

		const dockerArgs = ['compose', '-f', safePath, ...args];
		const legacyArgs = ['-f', safePath, ...args];
		const execEnv = env || process.env;

		// try docker CLI with 'compose'
		tryDockerCompose('docker', dockerArgs, execEnv).then(r => resolve(r)).catch(err1 => {
			// if the docker binary is missing (ENOENT), try legacy docker-compose; otherwise return docker's error
			const noDockerBinary = err1 && err1.err && err1.err.code === 'ENOENT';
			if (!noDockerBinary) {
				log('docker compose failed', err1 && (err1.err?err1.err.message:JSON.stringify(err1)));
				return reject(err1);
			}
			// fallback to docker-compose when docker binary not found
			tryDockerCompose('docker-compose', legacyArgs, execEnv).then(r => resolve(r)).catch(err2 => {
				log('docker-compose fallback failed', err2 && (err2.err?err2.err.message:JSON.stringify(err2)));
				// return the last error
				reject(err2);
			});
		});
	});
}

// format errors returned from execFile for JSON responses
function formatExecError(e) {
	if (!e) return { error: 'unknown error' };
	// if it's our rejected object with err, stdout, stderr
	if (typeof e === 'object') {
		return {
			error: (e.err && e.err.message) ? e.err.message : (e.message || String(e)),
			stdout: e.stdout || '',
			stderr: e.stderr || '',
			cmd: e.cmd || null,
			args: e.cmdArgs || null
		};
	}
	return { error: String(e) };
}

// GET status for a service: /api/status?path=...&service=core
app.get('/api/status', async (req, res) => {
	try {
		const file = req.query.path;
		const svc = req.query.service;
		
		if (!file || !svc) {
			return res.status(400).json({ error: 'Missing path or service parameter' });
		}
		
		if (!validateServiceName(svc)) {
			return res.status(400).json({ error: 'Invalid service name' });
		}
		
		let composeFile = sanitizePath(file);
		if (!composeFile) {
			return res.status(400).json({ error: 'Invalid path' });
		}
		
		if (fs.existsSync(path.join(composeFile, 'docker-compose.yml'))) {
			composeFile = path.join(composeFile, 'docker-compose.yml');
		}
		
		if (!fs.existsSync(composeFile)) {
			return res.status(404).json({ error: 'Compose file not found' });
		}
		
		try {
			// use unique project name to avoid conflicts
			const safeName = path.basename(path.dirname(composeFile)).replace(/[^A-Za-z0-9]/g, '').toLowerCase() || 'project';
			const execEnv = Object.assign({}, process.env, { COMPOSE_PROJECT_NAME: safeName });
			// try docker-compose ps <service>
			const r = await runCompose(composeFile, ['ps', '--services', '--filter', `status=running`], 10000, execEnv);
			const running = (r.stdout||'').split('\n').map(s=>s.trim()).filter(Boolean);
			res.json({ running: running.includes(svc), raw: r.stdout });
		} catch (e) {
			return res.status(500).json({ error: 'Service status check failed' });
		}
	} catch (e) {
		res.status(500).json({ error: 'Internal server error' });
	}
});

// POST attach: { path }
app.post('/api/attach', async (req, res) => {
	try {
		const file = req.body.path;
		if (!file) return res.status(400).json({ error: 'missing path' });
		let composeFile = file;
		if (fs.existsSync(path.join(file, 'docker-compose.yml'))) composeFile = path.join(file, 'docker-compose.yml');
		if (!fs.existsSync(composeFile)) return res.status(404).json({ error: 'compose file not found' });

		// use unique project name
		const safeName = path.basename(path.dirname(composeFile)).replace(/[^A-Za-z0-9]/g, '').toLowerCase() || 'project';
		const execEnv = Object.assign({}, process.env, { COMPOSE_PROJECT_NAME: safeName });

		try {
			// list running services
			const r = await runCompose(composeFile, ['ps', '--services', '--filter', 'status=running'], 10000, execEnv);
			const running = (r.stdout||'').split('\n').map(s=>s.trim()).filter(Boolean);

			// for each running service, try to get container id
			const commands = [];
			for (const svc of running) {
				try {
					// docker compose ps -q <service> to get container id (use 'docker compose' first)
					const q = await runCompose(composeFile, ['ps', '-q', svc], 5000, execEnv);
					const cid = (q.stdout||'').trim().split('\n').map(s=>s.trim()).filter(Boolean)[0] || null;
					if (cid) {
						// suggest using docker exec on container id
						commands.push(`docker exec -it ${cid} /bin/sh || docker exec -it ${cid} /bin/bash`);
					} else {
						// fall back to docker compose exec
						commands.push(`docker compose -f ${composeFile} exec ${svc} /bin/sh || docker compose -f ${composeFile} exec ${svc} /bin/bash`);
					}
				} catch (e) {
					commands.push(`docker compose -f ${composeFile} exec ${svc} /bin/sh || docker compose -f ${composeFile} exec ${svc} /bin/bash`);
				}
			}

			res.json({ ok: true, running, commands });
		} catch (e) {
			return res.status(500).json({ error: 'Failed to query running services' });
		}
	} catch (e) {
		res.status(500).json({ error: String(e) });
	}
});

// GET nginx config
app.get('/api/nginx', async (req, res) => {
	try {
		const f = path.join(__dirname, 'core', 'default.conf');
		if (!fs.existsSync(f)) return res.status(404).json({ error: 'nginx config not found' });
		const txt = fs.readFileSync(f, 'utf8');
		// robust parser: brace-aware
		function parseBlocks(s) {
			const out = [];
			let i = 0;
			while (i < s.length) {
				// skip whitespace
				if (s[i].match(/\s/)) { i++; continue; }
				// find the token until '{' or ';'
				let j = i;
				while (j < s.length && s[j] !== '{' && s[j] !== ';') j++;
				if (j >= s.length) break;
				const header = s.slice(i, j).trim();
				if (s[j] === ';') { out.push({ header, type: 'stmt', body: null }); i = j+1; continue; }
				// s[j] === '{'
				// find matching closing brace
				let depth = 0;
				let k = j;
				for (; k < s.length; k++) {
					if (s[k] === '{') depth++;
					else if (s[k] === '}') { depth--; if (depth === 0) break; }
				}
				const body = s.slice(j+1, k).trim();
				out.push({ header, type: 'block', body });
				i = k+1;
			}
			return out;
		}
		const parsed = { upstreams: [], servers: [] };
		try {
			const blocks = parseBlocks(txt);
			for (const b of blocks) {
				if (b.type === 'block' && b.header.startsWith('upstream ')) {
					const name = b.header.replace(/^upstream\s+/, '').trim();
					// parse inner statements for servers
					const inner = parseBlocks(b.body || '');
					const servers = inner.filter(x=>x.type==='stmt' && x.header.startsWith('server ')).map(x=>x.header.replace(/^server\s+/, '').trim().replace(/;$/,''));
					parsed.upstreams.push({ name, servers });
				} else if (b.type === 'block' && b.header.startsWith('server')) {
					const body = b.body || '';
					const listen = (body.match(/listen\s+([^;]+);/)||[])[1]||'';
					const server_name = (body.match(/server_name\s+([^;]+);/)||[])[1]||'';
					const ssl_certificate = (body.match(/ssl_certificate\s+([^;]+);/)||[])[1]||'';
					const ssl_certificate_key = (body.match(/ssl_certificate_key\s+([^;]+);/)||[])[1]||'';
					// locations: find 'location X { ... }' inside body using parseBlocks
					const inner = parseBlocks(body);
					const locations = [];
					for (const ib of inner) {
						if (ib.type === 'block' && ib.header.startsWith('location ')) {
							const locPath = ib.header.replace(/^location\s+/, '').trim();
							const locBody = ib.body || '';
							const proxy_pass = (locBody.match(/proxy_pass\s+([^;]+);/)||[])[1]||'';
							// detect return redirect statements like: return 301 https://example.com;
							const redirect_match = (locBody.match(/return\s+\d+\s+([^;]+);/)||[])[1]||'';
							const locObj = { location: locPath, proxy_pass: proxy_pass.trim(), raw: locBody.trim() };
							if (redirect_match) locObj.redirect = redirect_match.trim();
							locations.push(locObj);
						}
					}
					parsed.servers.push({ listen, server_name, ssl_certificate, ssl_certificate_key, locations });
				}
			}
		} catch (e) {
			// fallback to raw
		}
		res.json({ ok: true, content: txt, parsed });
	} catch (e) { res.status(500).json({ error: String(e) }); }
});

// POST save nginx config
app.post('/api/nginx/save', async (req, res) => {
	try {
		const body = req.body || {};
		const content = body.content;
		if (typeof content !== 'string') return res.status(400).json({ error: 'content required' });
		const f = path.join(__dirname, 'core', 'default.conf');
		const tmp = f + '.tmp.' + Date.now();
		// backup existing config if present
		let backedUp = false;
		try {
			if (fs.existsSync(f)) {
				fs.copyFileSync(f, tmp);
				backedUp = true;
			}
		} catch (e) {
			// non-fatal; continue but note we couldn't backup
			backedUp = false;
		}

		// write new content to live file
		fs.writeFileSync(f, content, 'utf8');

		// test nginx config (use nginx -t so nginx uses its default includes; we already wrote the file in place)
		try {
			await new Promise((resolve, reject) => {
				execFile('nginx', ['-t'], { timeout: 10000 }, (err, stdout, stderr) => {
					if (err) return reject({ err, stdout, stderr });
					resolve({ stdout, stderr });
				});
			});
		} catch (e) {
			// test failed - restore backup if available
			if (backedUp) {
				try { fs.copyFileSync(tmp, f); } catch (e2) { /* ignore restore error */ }
			}
			try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e3) {}
			return res.status(500).json({ ok: false, phase: 'test', result: formatExecError(e) });
		}

		// test succeeded -> reload nginx
		try {
			await new Promise((resolve, reject) => {
				execFile('nginx', ['-s', 'reload'], { timeout: 10000 }, (err, stdout, stderr) => {
					if (err) return reject({ err, stdout, stderr });
					resolve({ stdout, stderr });
				});
			});
			// cleanup backup
			try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) {}
			return res.json({ ok: true, applied: true });
		} catch (e2) {
			// try systemctl reload
			try {
				await new Promise((resolve, reject) => {
					execFile('systemctl', ['reload', 'nginx'], { timeout: 10000 }, (err, stdout, stderr) => {
						if (err) return reject({ err, stdout, stderr });
						resolve({ stdout, stderr });
					});
				});
				try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) {}
				return res.json({ ok: true, applied: true, method: 'systemctl' });
			} catch (e3) {
				// reload failed - restore backup
				if (backedUp) {
					try { fs.copyFileSync(tmp, f); } catch (er) { /* ignore */ }
				}
				try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e4) {}
				return res.status(500).json({ ok: false, phase: 'reload', result: formatExecError(e2) });
			}
		}
	} catch (e) { res.status(500).json({ error: String(e) }); }
});

// POST stop: { path, service }
app.post('/api/stop', async (req, res) => {
	try {
		const file = req.body.path;
		const svc = req.body.service;
		if (!file || !svc) return res.status(400).json({ error: 'missing path or service' });
		let composeFile = file;
		if (fs.existsSync(path.join(file, 'docker-compose.yml'))) composeFile = path.join(file, 'docker-compose.yml');
		if (!fs.existsSync(composeFile)) return res.status(404).json({ error: 'compose file not found' });
		try {
			// mark transient status
			transientStatus[path.dirname(composeFile)] = transientStatus[path.dirname(composeFile)] || {};
			transientStatus[path.dirname(composeFile)][svc] = 'stopping';
			// prefer project-provided stop.sh if present
			const stopScript = path.join(path.dirname(composeFile), 'stop.sh');
			if (fs.existsSync(stopScript) && fs.statSync(stopScript).mode & 0o111) {
				// execute the script with a scoped project name to avoid impacting other projects
				const safeName = path.basename(path.dirname(composeFile)).replace(/[^A-Za-z0-9]/g, '').toLowerCase() || 'project';
				const execEnv = Object.assign({}, process.env, { COMPOSE_PROJECT_NAME: safeName });
				const out = await new Promise((resolve, reject) => {
					execFile(stopScript, [svc], { timeout: 15000, cwd: path.dirname(composeFile), env: execEnv }, (err, stdout, stderr) => {
						if (err) return reject({ err, stdout, stderr, cmd: stopScript });
						resolve({ stdout, stderr });
					});
				});
				// Wait a bit and check if service is actually stopped before clearing transient status
				await new Promise(resolve => setTimeout(resolve, 2000));
				try {
					const checkRunning = await runCompose(composeFile, ['ps', '--services', '--filter', 'status=running'], 5000, execEnv);
					const stillRunning = (checkRunning.stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
					if (!stillRunning.includes(svc)) {
						delete transientStatus[path.dirname(composeFile)][svc];
					}
				} catch (e) {
					// If check fails, clear transient status anyway
					delete transientStatus[path.dirname(composeFile)][svc];
				}
				return res.json({ ok: true, stdout: out.stdout, stderr: out.stderr });
			}
			// use unique project name for docker compose commands
			const safeName = path.basename(path.dirname(composeFile)).replace(/[^A-Za-z0-9]/g, '').toLowerCase() || 'project';
			const execEnv = Object.assign({}, process.env, { COMPOSE_PROJECT_NAME: safeName });
			const result = await runCompose(composeFile, ['stop', svc], 10000, execEnv);
			
			// Wait a bit and check if service is actually stopped before clearing transient status
			await new Promise(resolve => setTimeout(resolve, 2000));
			try {
				const checkRunning = await runCompose(composeFile, ['ps', '--services', '--filter', 'status=running'], 5000, execEnv);
				const stillRunning = (checkRunning.stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
				if (!stillRunning.includes(svc)) {
					delete transientStatus[path.dirname(composeFile)][svc];
				}
			} catch (e) {
				// If check fails, clear transient status anyway
				delete transientStatus[path.dirname(composeFile)][svc];
			}
			
			res.json({ ok: true, stdout: result.stdout, stderr: result.stderr });
		} catch (e) {
			// some docker compose implementations write helpful messages to stderr while still stopping
			const stderr = (e && e.stderr) ? String(e.stderr) : '';
			if (/Stopping|Stopped|already stopped/i.test(stderr)) {
				// Wait a bit and check if service is actually stopped before clearing transient status
				await new Promise(resolve => setTimeout(resolve, 2000));
				try {
					const safeName = path.basename(path.dirname(composeFile)).replace(/[^A-Za-z0-9]/g, '').toLowerCase() || 'project';
					const execEnv = Object.assign({}, process.env, { COMPOSE_PROJECT_NAME: safeName });
					const checkRunning = await runCompose(composeFile, ['ps', '--services', '--filter', 'status=running'], 5000, execEnv);
					const stillRunning = (checkRunning.stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
					if (!stillRunning.includes(svc)) {
						delete transientStatus[path.dirname(composeFile)][svc];
					}
				} catch (checkErr) {
					// If check fails, clear transient status anyway
					delete transientStatus[path.dirname(composeFile)][svc];
				}
				return res.json({ ok: true, note: stderr });
			}
			delete transientStatus[path.dirname(composeFile)][svc];
			res.status(500).json({ error: 'Stop operation failed' });
		}
	} catch (e) { res.status(500).json({ error: 'Internal server error' }); }
});

// POST restart: { path, service }
app.post('/api/restart', async (req, res) => {
	try {
		const file = req.body.path;
		const svc = req.body.service;
		if (!file || !svc) return res.status(400).json({ error: 'missing path or service' });
		let composeFile = file;
		if (fs.existsSync(path.join(file, 'docker-compose.yml'))) composeFile = path.join(file, 'docker-compose.yml');
		if (!fs.existsSync(composeFile)) return res.status(404).json({ error: 'compose file not found' });
		try {
			transientStatus[path.dirname(composeFile)] = transientStatus[path.dirname(composeFile)] || {};
			transientStatus[path.dirname(composeFile)][svc] = 'restarting';
			// prefer project-provided restart.sh if present
			const restartScript = path.join(path.dirname(composeFile), 'restart.sh');
			if (fs.existsSync(restartScript) && fs.statSync(restartScript).mode & 0o111) {
				const safeName = path.basename(path.dirname(composeFile)).replace(/[^A-Za-z0-9]/g, '').toLowerCase() || 'project';
				const execEnv = Object.assign({}, process.env, { COMPOSE_PROJECT_NAME: safeName });
				let out;
				try {
					out = await new Promise((resolve, reject) => {
						execFile(restartScript, [svc], { timeout: 20000, cwd: path.dirname(composeFile), env: execEnv }, (err, stdout, stderr) => {
							if (err) return reject({ err, stdout, stderr, cmd: restartScript });
							resolve({ stdout, stderr });
						});
					});
				} catch (errObj) {
					// check for container name conflict and attempt to remove conflicting container then retry once
					const stderr = (errObj && errObj.stderr) ? String(errObj.stderr) : '';
					const match = stderr.match(/container name \"[^\"]+\" is already in use by container \"([0-9a-f]+)\"/i);
					if (match && match[1]) {
						const cid = match[1];
						try {
							await new Promise((res, rej) => {
								execFile('docker', ['rm', '-f', cid], { timeout: 15000 }, (e, so, se) => { if (e) return rej({ err: e, stdout: so, stderr: se }); res({ stdout: so, stderr: se }); });
							});
							// retry restart script once
								out = await new Promise((resolve, reject) => {
								execFile(restartScript, [svc], { timeout: 20000, cwd: path.dirname(composeFile), env: execEnv }, (err, stdout, stderr) => {
									if (err) return reject({ err, stdout, stderr, cmd: restartScript });
									resolve({ stdout, stderr });
								});
							});
						} catch (remErr) {
							// failed to remove or retry failed: return original error
							// Wait a bit and check if service is actually running before clearing transient status
							await new Promise(resolve => setTimeout(resolve, 2000));
							try {
								const checkRunning = await runCompose(composeFile, ['ps', '--services', '--filter', 'status=running'], 5000, execEnv);
								const running = (checkRunning.stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
								if (running.includes(svc)) {
									delete transientStatus[path.dirname(composeFile)][svc];
								}
							} catch (e) {
								// If check fails, clear transient status anyway
								delete transientStatus[path.dirname(composeFile)][svc];
							}
							return res.status(500).json(formatExecError(errObj));
						}
					} else {
						// Wait a bit and check if service is actually running before clearing transient status
						await new Promise(resolve => setTimeout(resolve, 2000));
						try {
							const checkRunning = await runCompose(composeFile, ['ps', '--services', '--filter', 'status=running'], 5000, execEnv);
							const running = (checkRunning.stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
							if (running.includes(svc)) {
								delete transientStatus[path.dirname(composeFile)][svc];
							}
						} catch (e) {
							// If check fails, clear transient status anyway
							delete transientStatus[path.dirname(composeFile)][svc];
						}
						return res.status(500).json(formatExecError(errObj));
					}
				}
				// Wait a bit and check if service is actually running before clearing transient status
				await new Promise(resolve => setTimeout(resolve, 2000));
				try {
					const checkRunning = await runCompose(composeFile, ['ps', '--services', '--filter', 'status=running'], 5000, execEnv);
					const running = (checkRunning.stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
					if (running.includes(svc)) {
						delete transientStatus[path.dirname(composeFile)][svc];
					}
				} catch (e) {
					// If check fails, clear transient status anyway
					delete transientStatus[path.dirname(composeFile)][svc];
				}
				return res.json({ ok: true, stdout: out && out.stdout || '', stderr: out && out.stderr || '' });
			}
			// use unique project name for docker compose commands
			const safeName = path.basename(path.dirname(composeFile)).replace(/[^A-Za-z0-9]/g, '').toLowerCase() || 'project';
			const execEnv = Object.assign({}, process.env, { COMPOSE_PROJECT_NAME: safeName });
			const result = await runCompose(composeFile, ['restart', svc], 10000, execEnv);
			
			// Wait a bit and check if service is actually running before clearing transient status
			await new Promise(resolve => setTimeout(resolve, 2000));
			try {
				const checkRunning = await runCompose(composeFile, ['ps', '--services', '--filter', 'status=running'], 5000, execEnv);
				const running = (checkRunning.stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
				if (running.includes(svc)) {
					delete transientStatus[path.dirname(composeFile)][svc];
				}
			} catch (e) {
				// If check fails, clear transient status anyway
				delete transientStatus[path.dirname(composeFile)][svc];
			}
			
			res.json({ ok: true, stdout: result.stdout, stderr: result.stderr });
		} catch (e) {
			const stderr = (e && e.stderr) ? String(e.stderr) : '';
			if (/Stopping|Stopped|Restarting|started|Started/i.test(stderr)) {
				// Wait a bit and check if service is actually running before clearing transient status
				await new Promise(resolve => setTimeout(resolve, 2000));
				try {
					const safeName = path.basename(path.dirname(composeFile)).replace(/[^A-Za-z0-9]/g, '').toLowerCase() || 'project';
					const execEnv = Object.assign({}, process.env, { COMPOSE_PROJECT_NAME: safeName });
					const checkRunning = await runCompose(composeFile, ['ps', '--services', '--filter', 'status=running'], 5000, execEnv);
					const running = (checkRunning.stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
					if (running.includes(svc)) {
						delete transientStatus[path.dirname(composeFile)][svc];
					}
				} catch (checkErr) {
					// If check fails, clear transient status anyway
					delete transientStatus[path.dirname(composeFile)][svc];
				}
				return res.json({ ok: true, note: stderr });
			}
			delete transientStatus[path.dirname(composeFile)][svc];
			res.status(500).json(formatExecError(e));
		}
	} catch (e) { res.status(500).json({ error: String(e) }); }
});

// POST apply changes: body should be { path: string, services: { <svc>: { ports?: [], networks?: { <net>: <ip|string> } } } }
app.post('/api/apply', async (req, res) => {
	try {
		const body = req.body || {};
		const targetPath = body.path; // project dir or full file path
		const services = body.services || {};
			if (!targetPath || Object.keys(services).length === 0) return res.status(400).json({ error: 'missing path or services' });
			// resolve docker-compose file path
			let composeFile = targetPath;
			if (fs.existsSync(path.join(targetPath, 'docker-compose.yml'))) composeFile = path.join(targetPath, 'docker-compose.yml');
			if (!fs.existsSync(composeFile)) return res.status(404).json({ error: 'compose file not found: ' + composeFile });
			const raw = fs.readFileSync(composeFile, 'utf8');
			const obj = parseCompose(raw) || {};
			// Replace services with the provided services set. The UI sends the full
			// services map (including additions/edits/removals). Replacing ensures
			// deletions performed in the editor are persisted to the compose file.
			obj.services = {};

			// gather used host ports across project to avoid collisions
			const usedHost = new Set();
			try {
				const all = await findProjectDirs(WORKSPACE_ROOT);
				for (const d of all) {
					const f = path.join(d, 'docker-compose.yml');
					try {
						const c = fs.readFileSync(f, 'utf8');
						const o = parseCompose(c) || {};
						for (const s of Object.values(o.services || {})) {
							if (s.ports) for (const pp of s.ports) {
								const parts = String(pp).split(':');
								const host = parts.length === 3 ? parseInt(parts[1],10) : (parts.length===2?parseInt(parts[0],10):null);
								if (host && !isNaN(host)) usedHost.add(host);
							}
						}
					} catch (e) {}
				}
			} catch (e) {}

			for (const [svcName, changes] of Object.entries(services)) {
				obj.services[svcName] = obj.services[svcName] || {};
				if (changes.ports) {
					// expected array of objects { container: '80', bind: '127.0.0.1' } or strings
					const outPorts = [];
					for (const p of changes.ports) {
						if (typeof p === 'string') {
							outPorts.push(p);
							continue;
						}
						const container = String(p.container || '').trim();
						const bind = p.bind || '0.0.0.0';
						if (!container) continue;
						// if host provided, honor it; else allocate
						let hostPort = p.host ? Number(p.host) : null;
						if (!hostPort) {
							// find next free starting at 10000
							let probe = 10000;
							while (usedHost.has(probe)) probe++;
							hostPort = probe;
							usedHost.add(hostPort);
						}
						// build mapping: if bind is an ip address, use ip:host:container else host:container
						if (/^\d+\.\d+\.\d+\.\d+$/.test(bind)) {
							outPorts.push(`${bind}:${hostPort}:${container}`);
						} else {
							outPorts.push(`${hostPort}:${container}`);
						}
					}
					log('DEBUG outPorts for', svcName, JSON.stringify(outPorts));
					obj.services[svcName].ports = outPorts;
				}

				// accept image field and set it
				if (changes.image) {
					obj.services[svcName].image = String(changes.image);
				}

				// accept restart policy
				if (changes.restart !== undefined) {
					// allow empty string to remove restart
					if (changes.restart === '' || changes.restart === null) delete obj.services[svcName].restart;
					else obj.services[svcName].restart = String(changes.restart);
				}

				// accept volumes array
				if (changes.volumes) {
					// expect array of strings like "host:container" or "container"
					obj.services[svcName].volumes = (Array.isArray(changes.volumes) ? changes.volumes.map(v=>String(v)) : []);
				}

				// accept environment array or object
				if (changes.environment) {
					if (Array.isArray(changes.environment)) {
						obj.services[svcName].environment = changes.environment.map(e=>String(e));
					} else if (typeof changes.environment === 'object') {
						obj.services[svcName].environment = changes.environment;
					}
				}
				if (changes.networks) {
					// Replace existing networks entirely with the provided mapping.
					// This allows clearing networks by sending an empty object and avoids
					// leaving stale network entries behind when switching subnets in the UI.
					obj.services[svcName].networks = {};
					for (const [netName, netVal] of Object.entries(changes.networks)) {
						// if netVal looks like an ipv4, set object with ipv4_address
						if (typeof netVal === 'string' && /^\d+\.\d+\.\d+\.\d+$/.test(netVal)) {
							obj.services[svcName].networks[netName] = { ipv4_address: netVal };
						} else {
							obj.services[svcName].networks[netName] = netVal;
						}
					}
				}
			}
		// ensure all ports are strings (coerce objects into canonical strings) before writing
		try {
			for (const [sname, svc] of Object.entries(obj.services || {})) {
				if (svc && Array.isArray(svc.ports)) {
					const mapped = svc.ports.map(p => {
						if (typeof p === 'string') return p;
						if (p && typeof p === 'object') {
							const container = (p.container || p.target || p.to || p.published || '').toString();
							const host = p.host || p.published || p.published_port || null;
							const bind = p.bind || p.address || null;
							if (container) {
								if (bind && host) return `${bind}:${host}:${container}`;
								if (host) return `${host}:${container}`;
								return `${container}`;
							}
						}
						// fallback: stringify safely
						try { return JSON.stringify(p); } catch(e) { return String(p); }
					});
					obj.services[sname].ports = mapped;
				}
			}
		} catch (e) {}

		writeCompose(composeFile, obj);
		// re-scan to refresh mapper.json
		await scanAndFix();
		res.json({ ok: true });
	} catch (e) {
		res.status(500).json({ error: String(e) });
	}
});

// POST add project: body should be { name: string }
app.post('/api/add', async (req, res) => {
	try {
		const body = req.body || {};
		const name = body.name;
		
		if (!name || typeof name !== 'string' || !name.trim()) {
			return res.status(400).json({ error: 'Valid name required' });
		}
		
		if (!validateProjectName(name.trim())) {
			return res.status(400).json({ error: 'Invalid project name. Use only alphanumeric characters, hyphens, underscores, and dots.' });
		}

		const appsDir = path.join(WORKSPACE_ROOT, 'apps');
		const templateDir = path.join(appsDir, 'template');
		const newDir = path.join(appsDir, name.trim());

		// check if template exists
		if (!fs.existsSync(templateDir)) {
			return res.status(404).json({ error: 'Template not found' });
		}

		// check if name is available
		if (fs.existsSync(newDir)) {
			return res.status(400).json({ error: 'Project name not available' });
		}

		// copy template to new dir
		function copyDir(src, dest) {
			fs.mkdirSync(dest, { recursive: true });
			const entries = fs.readdirSync(src, { withFileTypes: true });
			for (const entry of entries) {
				const srcPath = path.join(src, entry.name);
				const destPath = path.join(dest, entry.name);
				if (entry.isDirectory()) {
					copyDir(srcPath, destPath);
				} else {
					fs.copyFileSync(srcPath, destPath);
				}
			}
		}
		copyDir(templateDir, newDir);

		// make scripts executable
		const scripts = ['connect.sh', 'restart.sh', 'stop.sh'];
		for (const script of scripts) {
			const scriptPath = path.join(newDir, script);
			if (fs.existsSync(scriptPath)) {
				fs.chmodSync(scriptPath, 0o755);
			}
		}
		const composeFile = path.join(newDir, 'docker-compose.yml');
		if (fs.existsSync(composeFile)) {
			const raw = fs.readFileSync(composeFile, 'utf8');
			const obj = parseCompose(raw) || {};
			delete obj.version;

			// gather used host ports and IPs
			const usedHost = new Set();
			const usedIPs = new Set();
			try {
				const all = await findProjectDirs(WORKSPACE_ROOT);
				for (const d of all) {
					const f = path.join(d, 'docker-compose.yml');
					try {
						const c = fs.readFileSync(f, 'utf8');
						const o = parseCompose(c) || {};
						for (const s of Object.values(o.services || {})) {
							if (s.ports) for (const pp of s.ports) {
								const parts = String(pp).split(':');
								const host = parts.length === 3 ? parseInt(parts[1],10) : (parts.length===2?parseInt(parts[0],10):null);
								if (host && !isNaN(host)) usedHost.add(host);
							}
							if (s.networks) for (const n of Object.values(s.networks || {})) {
								if (typeof n === 'string' && /^\d+\.\d+\.\d+\.\d+$/.test(n)) usedIPs.add(n);
								else if (n && typeof n === 'object' && n.ipv4_address) usedIPs.add(n.ipv4_address);
							}
						}
					} catch (e) {}
				}
			} catch (e) {}

			// also check running containers for used IPs
			try {
				const { stdout } = await new Promise((resolve, reject) => {
					execFile('docker', ['network', 'inspect', 'neuxbane-core-net'], (error, stdout, stderr) => {
						if (error) reject(error);
						else resolve({ stdout, stderr });
					});
				});
				const netInfo = JSON.parse(stdout);
				for (const cont of Object.values(netInfo[0].Containers || {})) {
					const ip = cont.IPv4Address.split('/')[0];
					usedIPs.add(ip);
				}
			} catch (e) {}

			// update services
			for (const [svcName, svc] of Object.entries(obj.services || {})) {
				// update ports
				if (svc.ports) {
					const newPorts = [];
					for (const p of svc.ports) {
						const parts = String(p).split(':');
						let hostPort = null;
						if (parts.length === 3) {
							hostPort = parseInt(parts[1], 10);
						} else if (parts.length === 2) {
							hostPort = parseInt(parts[0], 10);
						}
						if (hostPort && !isNaN(hostPort)) {
							// find next free port
							let probe = hostPort;
							while (usedHost.has(probe)) probe++;
							usedHost.add(probe);
							if (parts.length === 3) {
								newPorts.push(`${parts[0]}:${probe}:${parts[2]}`);
							} else {
								newPorts.push(`${probe}:${parts[1]}`);
							}
						} else {
							newPorts.push(p);
						}
					}
					svc.ports = newPorts;
				}

				// update networks
				if (svc.networks) {
					for (const [netName, netVal] of Object.entries(svc.networks)) {
						if (typeof netVal === 'string' && /^\d+\.\d+\.\d+\.\d+$/.test(netVal)) {
							// find next free IP by max + 1
							let maxUsed = 0;
							for (const ip of usedIPs) {
								if (ip.startsWith('172.28.0.')) {
									const num = parseInt(ip.split('.')[3], 10);
									if (!isNaN(num) && num > maxUsed) maxUsed = num;
								}
							}
							const newIP = `172.28.0.${maxUsed + 1}`;
							usedIPs.add(newIP);
							svc.networks[netName] = { ipv4_address: newIP };
						}
					}
				}
			}

			writeCompose(composeFile, obj);
		}

		// re-scan to refresh mapper.json
		await scanAndFix();
		res.json({ ok: true });
	} catch (e) {
		res.status(500).json({ error: String(e) });
	}
});

// POST rename: { oldPath, newName }
app.post('/api/rename', async (req, res) => {
	try {
		const body = req.body || {};
		const oldPath = body.oldPath;
		const newName = body.newName;
		
		if (!oldPath || !newName || typeof newName !== 'string' || !newName.trim()) {
			return res.status(400).json({ error: 'Valid oldPath and newName required' });
		}
		
		if (!validateProjectName(newName.trim())) {
			return res.status(400).json({ error: 'Invalid project name. Use only alphanumeric characters, hyphens, underscores, and dots.' });
		}

		// Prevent renaming the template project
		const projectName = path.basename(oldPath);
		if (projectName === 'template') {
			return res.status(400).json({ error: 'Cannot rename the template project' });
		}

		const appsDir = path.join(WORKSPACE_ROOT, 'apps');
		const oldDir = path.join(appsDir, path.basename(oldPath));
		const newDir = path.join(appsDir, newName.trim());

		// check if old directory exists
		if (!fs.existsSync(oldDir)) {
			return res.status(404).json({ error: 'Project not found' });
		}

		// check if new name is available
		if (fs.existsSync(newDir)) {
			return res.status(400).json({ error: 'Project name not available' });
		}

		// check if all services are stopped
		const composeFile = path.join(oldDir, 'docker-compose.yml');
		if (fs.existsSync(composeFile)) {
			try {
				const safeName = path.basename(oldDir).replace(/[^A-Za-z0-9]/g, '').toLowerCase() || 'project';
				const execEnv = Object.assign({}, process.env, { COMPOSE_PROJECT_NAME: safeName });
				const r = await runCompose(composeFile, ['ps', '--services', '--filter', 'status=running'], 10000, execEnv);
				const running = (r.stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
				if (running.length > 0) {
					return res.status(400).json({ error: 'Cannot rename project with running services. Please stop all services first.' });
				}
			} catch (e) {
				// ignore ps failures, assume stopped
			}
		}

		// rename directory
		fs.renameSync(oldDir, newDir);

		// re-scan to refresh mapper.json
		await scanAndFix();
		res.json({ ok: true });
	} catch (e) {
		res.status(500).json({ error: String(e) });
	}
});

// POST delete: { path, confirmName }
app.post('/api/delete', async (req, res) => {
	try {
		const body = req.body || {};
		const projectPath = body.path;
		const confirmName = body.confirmName;
		
		if (!projectPath || !confirmName) {
			return res.status(400).json({ error: 'Valid path and confirmName required' });
		}

		const appsDir = path.join(WORKSPACE_ROOT, 'apps');
		const projectDir = path.join(appsDir, path.basename(projectPath));
		const expectedName = path.basename(projectPath);

		// check if directory exists
		if (!fs.existsSync(projectDir)) {
			return res.status(404).json({ error: 'Project not found' });
		}

		// verify confirmation name matches
		if (confirmName !== expectedName) {
			return res.status(400).json({ error: 'Confirmation name does not match project name' });
		}

		// Prevent deleting the template project
		if (expectedName === 'template') {
			return res.status(400).json({ error: 'Cannot delete the template project' });
		}

		// check if all services are stopped
		const composeFile = path.join(projectDir, 'docker-compose.yml');
		if (fs.existsSync(composeFile)) {
			try {
				const safeName = path.basename(projectDir).replace(/[^A-Za-z0-9]/g, '').toLowerCase() || 'project';
				const execEnv = Object.assign({}, process.env, { COMPOSE_PROJECT_NAME: safeName });
				const r = await runCompose(composeFile, ['ps', '--services', '--filter', 'status=running'], 10000, execEnv);
				const running = (r.stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
				if (running.length > 0) {
					return res.status(400).json({ error: 'Cannot delete project with running services. Please stop all services first.' });
				}
			} catch (e) {
				// ignore ps failures, assume stopped
			}
		}

		// delete directory recursively
		fs.rmSync(projectDir, { recursive: true, force: true });

		// re-scan to refresh mapper.json
		await scanAndFix();
		res.json({ ok: true });
	} catch (e) {
		res.status(500).json({ error: String(e) });
	}
});

// POST save config file: { path, filename, content }
app.post('/api/save-config', async (req, res) => {
	try {
		const body = req.body || {};
		const projectPath = body.path;
		const filename = body.filename;
		const content = body.content;
		
		if (!projectPath || !filename || content === undefined) {
			return res.status(400).json({ error: 'Valid path, filename, and content required' });
		}

		// Validate filename to prevent directory traversal
		if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
			return res.status(400).json({ error: 'Invalid filename' });
		}

		const appsDir = path.join(WORKSPACE_ROOT, 'apps');
		const projectDir = path.join(appsDir, path.basename(projectPath));
		const configDir = path.join(projectDir, 'config');
		const filePath = path.join(configDir, filename);

		// Ensure config directory exists
		if (!fs.existsSync(configDir)) {
			fs.mkdirSync(configDir, { recursive: true });
		}

		// Write the file
		fs.writeFileSync(filePath, content, 'utf8');
		
		res.json({ ok: true });
	} catch (e) {
		res.status(500).json({ error: String(e) });
	}
});

// GET config file: /api/config?path=...&filename=...
app.get('/api/config', async (req, res) => {
	try {
		const projectPath = req.query.path;
		const filename = req.query.filename;
		
		if (!projectPath || !filename) {
			return res.status(400).json({ error: 'Valid path and filename required' });
		}

		// Validate filename to prevent directory traversal
		if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
			return res.status(400).json({ error: 'Invalid filename' });
		}

		const appsDir = path.join(WORKSPACE_ROOT, 'apps');
		const projectDir = path.join(appsDir, path.basename(projectPath));
		const configDir = path.join(projectDir, 'config');
		const filePath = path.join(configDir, filename);

		if (!fs.existsSync(filePath)) {
			return res.status(404).json({ error: 'Config file not found' });
		}

		const content = fs.readFileSync(filePath, 'utf8');
		res.json({ content, filename });
	} catch (e) {
		res.status(500).json({ error: String(e) });
	}
});

// GET list config files: /api/config-files?path=...
app.get('/api/config-files', async (req, res) => {
	try {
		const projectPath = req.query.path;
		
		if (!projectPath) {
			return res.status(400).json({ error: 'Valid path required' });
		}

		const appsDir = path.join(WORKSPACE_ROOT, 'apps');
		const projectDir = path.join(appsDir, path.basename(projectPath));
		const configDir = path.join(projectDir, 'config');

		if (!fs.existsSync(configDir)) {
			return res.json({ files: [] });
		}

		const files = fs.readdirSync(configDir)
			.filter(file => fs.statSync(path.join(configDir, file)).isFile())
			.map(filename => {
				const filePath = path.join(configDir, filename);
				const stats = fs.statSync(filePath);
				return {
					name: filename,
					size: stats.size,
					modified: stats.mtime.toISOString(),
					extension: path.extname(filename).toLowerCase()
				};
			});

		res.json({ files });
	} catch (e) {
		res.status(500).json({ error: String(e) });
	}
});

import https from 'https';
import http from 'http';
import { WebSocketServer } from 'ws';
import pty from 'node-pty';

// ... existing code ...

const PORT = process.env.PORT || 3333;
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;
const USE_HTTPS = process.env.USE_HTTPS === 'true';
// binding address for servers; default to loopback for safety
const BIND_ADDR = process.env.BIND_ADDR || '127.0.0.1';

if (!process.env.SINGLE_RUN) {
	// Start HTTP server
	const httpServer = http.createServer(app);
	httpServer.listen(PORT, BIND_ADDR, () => {
		log('HTTP server listening on http://' + BIND_ADDR + ':' + PORT);
	});

	// WebSocket server for terminal attach proxy
	try {
		const wss = new WebSocketServer({ server: httpServer, path: '/ws/attach' });
		wss.on('connection', (ws, req) => {
			// track active terminal sessions to avoid scanner interference
			if (typeof globalThis.activeTerminalCount !== 'number') globalThis.activeTerminalCount = 0;
			globalThis.activeTerminalCount++;
			log('terminal connection opened, activeTerminalCount=' + globalThis.activeTerminalCount);
			// expect query params: ?file=<composeFile>&service=<svc>
			try {
				const urlParts = new URL(req.url, `http://${req.headers.host}`);
				const params = urlParts.searchParams;
				const file = params.get('file');
				const svc = params.get('service');
				const action = params.get('action'); // optional: 'restart' | 'stop' | 'inspect' | 'log'
				if (!file || !svc) {
					ws.send(JSON.stringify({ error: 'missing file or service' }));
					ws.close();
					// decrement count immediately since we didn't create a session
					globalThis.activeTerminalCount = Math.max(0, (globalThis.activeTerminalCount||0) - 1);
					log('terminal connection rejected, activeTerminalCount=' + globalThis.activeTerminalCount);
					return;
				}
				let composeFile = file;
				if (fs.existsSync(path.join(file, 'docker-compose.yml'))) composeFile = path.join(file, 'docker-compose.yml');
				if (!fs.existsSync(composeFile)) { ws.send(JSON.stringify({ error: 'compose file not found' })); ws.close(); globalThis.activeTerminalCount = Math.max(0, (globalThis.activeTerminalCount||0) - 1); log('compose not found, activeTerminalCount=' + globalThis.activeTerminalCount); return; }
				const safeName = path.basename(path.dirname(composeFile)).replace(/[^A-Za-z0-9]/g, '').toLowerCase() || 'project';
				const execEnv = Object.assign({}, process.env, { COMPOSE_PROJECT_NAME: safeName });
						// If an action (inspect/restart/stop) is requested, spawn the action command in a pty and stream output.
						if (action === 'inspect') {
							const projectDir = path.dirname(composeFile);
							// Do not modify transientStatus here; Inspect is read-only and should not affect service status
							// send recent logs first
							(async () => {
								try {
									const logs = await runCompose(composeFile, ['logs', '--no-color', '--tail', '500', svc], 20000, execEnv);
									if (logs && logs.stdout) ws.send(logs.stdout);
									if (logs && logs.stderr) ws.send(logs.stderr);
								} catch (e) {
									try { ws.send(JSON.stringify({ error: 'failed to fetch past logs' })); } catch (e) {}
								}
								// then follow logs live (non-disruptive). Prefer a project-provided `inspect.sh` if present.
								const projectDirLocal = path.dirname(composeFile);
								const scriptPath = path.join(projectDirLocal, 'inspect.sh'); // optional project override for custom inspect behavior
								let cmd = 'bash';
								let args = ['-lc', 'echo "no-op"'];
								// We'll use a firstRun flag so the first spawn gets --tail 500 (recent history),
								// while subsequent respawns use --tail 0 -f so they don't resend previous history.
								let firstRun = true;
								if (fs.existsSync(scriptPath) && (fs.statSync(scriptPath).mode & 0o111)) {
									// run project-provided inspect script which should be non-disruptive
									// project scripts may not support tail semantics; call them the same each time
									args = ['-lc', `${JSON.stringify(scriptPath)} ${JSON.stringify(svc)}`];
								} else {
									// default to following compose logs (non-disruptive)
									const logsFollowInit = `docker compose -f ${JSON.stringify(composeFile)} logs --no-color --tail 500 -f ${JSON.stringify(svc)}`;
									const legacyLogsFollowInit = `docker-compose -f ${JSON.stringify(composeFile)} logs --no-color --tail 500 -f ${JSON.stringify(svc)}`;
									const logsFollowRespawn = `docker compose -f ${JSON.stringify(composeFile)} logs --no-color --tail 0 -f ${JSON.stringify(svc)}`;
									const legacyLogsFollowRespawn = `docker-compose -f ${JSON.stringify(composeFile)} logs --no-color --tail 0 -f ${JSON.stringify(svc)}`;
									// default args are for initial spawn; spawnFollow will choose respawn args when firstRun=false
									args = ['-lc', `${logsFollowInit} || ${legacyLogsFollowInit}`];
								}
								// spawn-follow loop: keep the websocket open and re-spawn the pty when logs exit
								// Silent reconnect policy: when the follow process exits, quietly attempt to
								// reconnect every 3 seconds in the background. Do not spam the client with
								// repeated 'reconnecting' messages. Keep the socket open until the client
								// explicitly closes it or the server decides to close for other reasons.
								let sessionClosed = false;
								let term = null;
								// ensure we only notify the client once that the log stream paused
								let pauseNotified = false;
											// track last data time and monitor idle state
											let lastDataAt = Date.now();
											let monitorInterval = null;
											let countdownTimer = null;
											let countdownActive = false;

								const onCloseCleanup = () => {
									if (sessionClosed) return; sessionClosed = true;
									try { if (term) term.kill(); } catch (e) {}
									try { globalThis.activeTerminalCount = Math.max(0, (globalThis.activeTerminalCount||0) - 1); } catch (e) {}
									log('terminal connection closed, activeTerminalCount=' + globalThis.activeTerminalCount);
								};

								const spawnFollow = () => {
									if (sessionClosed) return;
									try {
										// choose args based on whether this is the initial run or a respawn
										let chosenArgs = args;
										if (!firstRun && !(fs.existsSync(scriptPath) && (fs.statSync(scriptPath).mode & 0o111))) {
											// Prefer requesting logs since the last received timestamp so that when the
											// container restarts we catch lines produced during downtime without
											// reprinting the whole history. Fallback to --tail 0 if lastDataAt missing.
											let sincePart = '';
											try {
												if (lastDataAt) {
													const iso = new Date(lastDataAt).toISOString();
													sincePart = `--since ${JSON.stringify(iso)}`;
												}
											} catch (e) { sincePart = ''; }
											const logsFollowRespawn = sincePart ? `docker compose -f ${JSON.stringify(composeFile)} logs --no-color ${sincePart} -f ${JSON.stringify(svc)}` : `docker compose -f ${JSON.stringify(composeFile)} logs --no-color --tail 0 -f ${JSON.stringify(svc)}`;
											const legacyLogsFollowRespawn = sincePart ? `docker-compose -f ${JSON.stringify(composeFile)} logs --no-color ${sincePart} -f ${JSON.stringify(svc)}` : `docker-compose -f ${JSON.stringify(composeFile)} logs --no-color --tail 0 -f ${JSON.stringify(svc)}`;
											chosenArgs = ['-lc', `${logsFollowRespawn} || ${legacyLogsFollowRespawn}`];
										}
										term = pty.spawn(cmd, chosenArgs, { name: 'xterm-color', cols: 80, rows: 24, env: execEnv, cwd: projectDirLocal });
									} catch (e) {
										try { ws.send(JSON.stringify({ error: 'failed to spawn log follow' })); } catch (e2) {}
										return;
									}

                                    // update lastDataAt on actual output; clear pauseNotified so a future pause
                                    // will notify once again
                                    term.onData(d => { try { ws.send(d); lastDataAt = Date.now(); pauseNotified = false; } catch (e) {} });

									// start idle monitor once
									if (!monitorInterval) {
										monitorInterval = setInterval(() => {
											try {
												if (sessionClosed) { clearInterval(monitorInterval); monitorInterval = null; return; }
												const idleMs = Date.now() - (lastDataAt || 0);
												// if no new data for 60s, start 5s countdown to close
												if (idleMs > 60000 && !countdownActive) {
													countdownActive = true;
													let remaining = 5;
													try { ws.send('\r\n\x1b[31mNo new logs for 60s. Closing window in ' + remaining + 's\x1b[0m\r\n'); } catch (e) {}
													countdownTimer = setInterval(() => {
														// if new data arrived, cancel countdown
														if (Date.now() - (lastDataAt || 0) <= 60000) {
															clearInterval(countdownTimer); countdownTimer = null; countdownActive = false; try { ws.send('\r\n\x1b[32mNew logs received — countdown cancelled\x1b[0m\r\n'); } catch (e) {}
															return;
														}
														remaining -= 1;
														if (remaining <= 0) {
															try { ws.send('\r\n\x1b[31mClosing terminal due to inactivity\x1b[0m\r\n'); } catch (e) {}
															try { ws.close(); } catch (e) {}
															clearInterval(countdownTimer); countdownTimer = null; countdownActive = false;
															return;
														}
														try { ws.send('\r\n\x1b[31mClosing in ' + remaining + 's...\x1b[0m\r\n'); } catch (e) {}
													}, 1000);
												}
											} catch (e) {}
										}, 1000);
									}

									// when the follow process exits, silently attempt to respawn after 3s
									term.on('exit', (code, signal) => {
										try {
											if (!pauseNotified) {
												ws.send('\r\n\x1b[33mLog stream paused (container may have stopped)\x1b[0m\r\n');
												pauseNotified = true;
											}
										} catch (e) {}
										// Silent reconnect every 3 seconds; do not send repeated reconnect messages
										// mark that subsequent spawns are respawns so they use --tail 0 / --since
										firstRun = false;
										setTimeout(() => {
											try {
												if (!sessionClosed && ws && ws.readyState === 1) spawnFollow();
											} catch (e) {}
										}, 3000);
									});

									// allow client resize messages to apply to the active term
									const messageHandler = (msg) => {
										try {
											const s = msg.toString();
											if (s[0] === '{') {
												const obj = JSON.parse(s);
												if (obj && obj.type === 'resize' && obj.cols && obj.rows) { try { term.resize(Number(obj.cols), Number(obj.rows)); } catch (e) {} return; }
											}
											term.write(s);
										} catch (e) { try { term.write(msg.toString()); } catch (e) {} }
									};

									// attach a temporary message listener for this spawned term
									ws.removeEventListener && ws.removeEventListener('message', messageHandler);
									ws.on('message', messageHandler);
								};

								// start the follow loop
								spawnFollow();

								// cleanup when ws closes
								ws.on('close', () => { onCloseCleanup(); if (monitorInterval) { clearInterval(monitorInterval); monitorInterval = null; } if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; } });
							})();
							return;
						}

						// New: live nginx comm.log stream filtered by service IP (action=log&ip=...)
						if (action === 'log') {
							let rawIp = params.get('ip') || '';
							const isIpv4 = (s) => /^\d+\.\d+\.\d+\.\d+$/.test(String(s||'').trim());
							// If ip missing/invalid, try to resolve from mapper.json using project dir and service name
							if (!isIpv4(rawIp)) {
								try {
									const mapper = readMapperFile() || {};
									const projectDir = path.dirname(composeFile);
									const entry = mapper[projectDir] || mapper[projectDir.replace(/\\/g, '/')] || null;
									if (entry && entry.services && entry.services[svc]) {
										const svcNet = entry.services[svc].networks || {};
										// try common network key neuxbane-core-net or take first network value
										let candidate = null;
										if (svcNet['neuxbane-core-net']) candidate = svcNet['neuxbane-core-net'];
										else {
											const vals = Object.values(svcNet || {});
											if (vals.length > 0) candidate = vals[0];
										}
										if (candidate) {
											if (typeof candidate === 'string') rawIp = candidate;
											else if (candidate && typeof candidate === 'object') rawIp = candidate.ipv4_address || candidate.ipv4Address || '';
										}
									}
								} catch (e) {
									// ignore
								}
							}
							if (!isIpv4(rawIp)) { try { ws.send(JSON.stringify({ error: 'invalid or missing ip' })); } catch(e){} ws.close(); globalThis.activeTerminalCount = Math.max(0, (globalThis.activeTerminalCount||0) - 1); return; }
							const cmd = 'bash';
							// Use stdbuf to force line-buffered grep so logs stream in realtime
							// match the upstream field which is quoted and may include a port (e.g. "172.28.0.4:80")
							const escapedIp = String(rawIp).replace(/\./g, '\\.') ;
							const tailCmd = `if [ -r /var/log/nginx/comm.log ]; then tail -n 500 -F /var/log/nginx/comm.log | stdbuf -oL -eL grep -E --line-buffered '\"${escapedIp}(:[0-9]+)?\"'; else echo "comm.log not found or not readable"; fi`;
							let term = null;
							try { term = pty.spawn(cmd, ['-lc', tailCmd], { name: 'xterm-color', cols: 80, rows: 24, env: process.env, cwd: process.cwd() }); }
							catch (e) { try { ws.send(JSON.stringify({ error: 'failed to spawn log stream' })); } catch(e2){} try { ws.close(); } catch(e3){} globalThis.activeTerminalCount = Math.max(0, (globalThis.activeTerminalCount||0) - 1); return; }
							try { ws.send(JSON.stringify({ info: `following`, ip: rawIp, note: 'initializing structured log stream' })); } catch(e){}
							// Lightweight parser for the common nginx combined+upstream format used by comm.log
							const parseLine = (line) => {
								if (!line || typeof line !== 'string') return null;
								// Example format (common):
								// 78.153.140.224 - - [07/Sep/2025:08:22:34 +0700] "GET /dev/.env HTTP/1.1" 404 162 "-" "UA" "172.28.0.4:80"
								const m = line.match(/^([^\s]+)\s+-\s+-\s+\[([^\]]+)\]\s+"([A-Z]+)\s+([^\s]+)\s+HTTP\/[\d.]+"\s+(\d{3})\s+(\d+)\s+"([^"]*)"\s+"([^"]*)"\s+"([^\"]+)"/);
								if (!m) return { raw: line };
								return {
									remote: m[1],
									time: m[2],
									method: m[3],
									path: m[4],
									status: Number(m[5]),
									size: Number(m[6]),
									referer: m[7],
									ua: m[8],
									upstream: m[9]
								};
							};
							// Send parsed JSON objects for each line
							term.onData(d => {
								try {
									const lines = String(d).split(/\r?\n/).filter(Boolean);
									for (const L of lines) {
										const obj = parseLine(L);
										if (obj) ws.send(JSON.stringify({ log: obj }));
									}
								} catch (e) { try { ws.send(JSON.stringify({ error: 'parse_error', detail: String(e) })); } catch(e2){} }
							});
							let sessionClosed = false;
							const onCloseCleanup = () => { if (sessionClosed) return; sessionClosed = true; try { term.kill(); } catch(e){} try { globalThis.activeTerminalCount = Math.max(0, (globalThis.activeTerminalCount||0) - 1); } catch(e){} log('log stream closed, activeTerminalCount=' + globalThis.activeTerminalCount); };
							term.on('exit', () => { onCloseCleanup(); try { ws.close(); } catch(e){} });
							ws.on('message', msg => {
								// allow optional resize messages from terminal.html, ignore other input
								try { const s = msg.toString(); if (s[0] === '{') { const obj = JSON.parse(s); if (obj && obj.type === 'resize' && obj.cols && obj.rows) { try { term.resize(Number(obj.cols), Number(obj.rows)); } catch(e){} } } } catch(e){}
							});
							ws.on('close', () => { onCloseCleanup(); });
							return;
						}
						if (action === 'restart' || action === 'stop') {
						const projectDir = path.dirname(composeFile);
						transientStatus[projectDir] = transientStatus[projectDir] || {};
						transientStatus[projectDir][svc] = action === 'restart' ? 'restarting' : 'stopping';
						// prefer project-provided script if available and executable
						const scriptPath = path.join(projectDir, action + '.sh');
						let cmd = 'bash';
						let args = ['-lc', 'echo "no-op"'];
						if (fs.existsSync(scriptPath) && (fs.statSync(scriptPath).mode & 0o111)) {
							// run the project's script
							args = ['-lc', `${JSON.stringify(scriptPath)} ${JSON.stringify(svc)}`];
						} else {
							// fallback to docker compose command via shell so docker/docker-compose choices work
							const composeCmd = `docker compose -f ${JSON.stringify(composeFile)} ${action} ${JSON.stringify(svc)}`;
							const legacyCmd = `docker-compose -f ${JSON.stringify(composeFile)} ${action} ${JSON.stringify(svc)}`;
							// try compose then legacy; running in shell allows either to execute
							args = ['-lc', `${composeCmd} || ${legacyCmd}`];
						}

						const term = pty.spawn(cmd, args, {
							name: 'xterm-color',
							cols: 80,
							rows: 24,
							env: execEnv,
							cwd: projectDir
						});

						term.onData(d => { try { ws.send(d); } catch (e) {} });
						let sessionClosed = false;
						const onCloseCleanup = () => {
							if (sessionClosed) return; sessionClosed = true;
							try { term.kill(); } catch (e) {}
							try { globalThis.activeTerminalCount = Math.max(0, (globalThis.activeTerminalCount||0) - 1); } catch (e) {}
							log('terminal connection closed, activeTerminalCount=' + globalThis.activeTerminalCount);
							// clear transient status
							try { delete transientStatus[projectDir][svc]; } catch (e) {}
						};
						term.on('exit', (code, signal) => { onCloseCleanup(); try { ws.close(); } catch (e) {} });
						ws.on('message', msg => {
							try {
								const s = msg.toString();
								if (s[0] === '{') {
									const obj = JSON.parse(s);
									if (obj && obj.type === 'resize' && obj.cols && obj.rows) {
										try { term.resize(Number(obj.cols), Number(obj.rows)); } catch (e) {}
										return;
									}
								}
								term.write(s);
							} catch (e) {
								try { term.write(msg.toString()); } catch (e) {}
							}
						});
						ws.on('close', () => { onCloseCleanup(); });
						return;
					}

					// find container id (existing behavior)
				runCompose(composeFile, ['ps', '-q', svc], 5000, execEnv).then(q => {
					const cid = (q.stdout||'').trim().split('\n').map(s=>s.trim()).filter(Boolean)[0];
					if (!cid) { ws.send(JSON.stringify({ error: 'container id not found' })); ws.close(); globalThis.activeTerminalCount = Math.max(0, (globalThis.activeTerminalCount||0) - 1); log('cid not found, activeTerminalCount=' + globalThis.activeTerminalCount); return; }
					// spawn docker exec -it <cid> sh
					const shell = process.env.SHELL || '/bin/sh';
					const term = pty.spawn('docker', ['exec', '-it', cid, shell], {
						name: 'xterm-color',
						cols: 80,
						rows: 24,
						env: process.env
					});
					term.onData(d => { try { ws.send(d); } catch (e) {} });
					let sessionClosed = false; // guard to ensure we decrement activeTerminalCount only once
					const onCloseCleanup = () => {
						if (sessionClosed) return; sessionClosed = true;
						try { term.kill(); } catch (e) {}
						try { globalThis.activeTerminalCount = Math.max(0, (globalThis.activeTerminalCount||0) - 1); } catch (e) {}
						log('terminal connection closed, activeTerminalCount=' + globalThis.activeTerminalCount);
					};
					term.on('exit', (code, signal) => { onCloseCleanup(); try { ws.close(); } catch (e) {} });
					ws.on('message', msg => {
						// expect either raw data to write to pty or JSON control messages
						try {
							const s = msg.toString();
							if (s[0] === '{') {
								const obj = JSON.parse(s);
								if (obj && obj.type === 'resize' && obj.cols && obj.rows) {
									try { term.resize(Number(obj.cols), Number(obj.rows)); } catch (e) {}
									return;
								}
							}
							// fallback: write raw
							term.write(s);
						} catch (e) {
							try { term.write(msg.toString()); } catch (e) {}
						}
					});
					ws.on('close', () => { onCloseCleanup(); });
				}).catch(err => { ws.send(JSON.stringify({ error: 'failed to locate container' })); ws.close(); globalThis.activeTerminalCount = Math.max(0, (globalThis.activeTerminalCount||0) - 1); log('failed locate container, activeTerminalCount=' + globalThis.activeTerminalCount); });
			} catch (e) { try { ws.send(JSON.stringify({ error: String(e) })); } catch (e2){} ws.close(); globalThis.activeTerminalCount = Math.max(0, (globalThis.activeTerminalCount||0) - 1); }
		});
	} catch (e) { log('ws setup failed', e && e.message ? e.message : e); }

	// Start HTTPS server if enabled and certificates exist
	if (USE_HTTPS) {
		const keyPath = process.env.SSL_KEY_PATH || path.join(__dirname, 'ssl', 'key.pem');
		const certPath = process.env.SSL_CERT_PATH || path.join(__dirname, 'ssl', 'cert.pem');
		
		if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
			const httpsOptions = {
				key: fs.readFileSync(keyPath),
				cert: fs.readFileSync(certPath)
			};
			
			const httpsServer = https.createServer(httpsOptions, app);
			httpsServer.listen(HTTPS_PORT, BIND_ADDR, () => {
				log('HTTPS server listening on https://' + BIND_ADDR + ':' + HTTPS_PORT);
			});
		} else {
			log('HTTPS enabled but SSL certificates not found at', keyPath, 'and', certPath);
		}
	}
}

// API for public stats
app.get('/api/stats', async (req, res) => {
	try {
		const range = req.query.range || '1h'; // 1h, 6h, 1day, 3day, 1week, 1month
		const now = Date.now();
		let startTime;
		switch (range) {
			case '1h': startTime = now - 3600000; break;
			case '6h': startTime = now - 21600000; break;
			case '1day': startTime = now - 86400000; break;
			case '3day': startTime = now - 259200000; break;
			case '1week': startTime = now - 604800000; break;
			case '1month': startTime = now - 2592000000; break;
			default: startTime = now - 3600000;
		}
		// parse nginx logs (both access.log and comm.log)
		const logFiles = ['/var/log/nginx/access.log', '/var/log/nginx/comm.log'];
		let allLines = [];
		
		for (const logFile of logFiles) {
			if (fs.existsSync(logFile)) {
				const logData = fs.readFileSync(logFile, 'utf8');
				const lines = logData.split('\n').filter(l => l.trim());
				allLines = allLines.concat(lines);
			}
		}
		
		// Load mapper to map IPs to project names
		const mapper = readMapperFile() || {};
		const ipToProject = {};
		const projectNames = new Set();

		// Build IP to project name mapping and collect known project names
		for (const [projectPath, projectData] of Object.entries(mapper)) {
			const projectName = path.basename(projectPath);
			projectNames.add(projectName);
			for (const [serviceName, serviceData] of Object.entries(projectData.services || {})) {
				if (serviceData.networks && serviceData.networks['neuxbane-core-net']) {
					const networkConfig = serviceData.networks['neuxbane-core-net'];
					let ip = null;
					if (typeof networkConfig === 'string') {
						ip = networkConfig;
					} else if (networkConfig.ipv4_address) {
						ip = networkConfig.ipv4_address;
					}
					if (ip) {
						ipToProject[ip] = projectName;
					}
				}
			}
		}
		
		// define interval based on range
		let intervalMs;
		switch (range) {
			case '1h': intervalMs = 5 * 60 * 1000; break; // 5 min
			case '6h': intervalMs = 30 * 60 * 1000; break; // 30 min
			case '1day': intervalMs = 2 * 60 * 60 * 1000; break; // 2 hours
			case '3day': intervalMs = 6 * 60 * 60 * 1000; break; // 6 hours
			case '1week': intervalMs = 24 * 60 * 60 * 1000; break; // 1 day
			case '1month': intervalMs = 7 * 24 * 60 * 60 * 1000; break; // 1 week
			default: intervalMs = 5 * 60 * 1000;
		}
		
		const services = {};
		const timeSlots = [];
		let currentSlot = startTime;
		while (currentSlot < now) {
			timeSlots.push(currentSlot);
			currentSlot += intervalMs;
		}
		
		for (const line of allLines) {
			// attempt to parse common nginx log patterns
			// Examples:
			// 127.0.0.1 - - [06/Sep/2025:12:34:56 +0000] "GET /path HTTP/1.1" 200 123 "-" "ua" "172.28.0.2:80"
			// 127.0.0.1 - - [06/Sep/2025:12:34:56 +0200] "GET /path HTTP/1.1" 200 123 "-" "ua"
			try {
				// Extract timestamp (between first [ and ])
				const tsMatch = line.match(/\[([^\]]+)\]/);
				if (!tsMatch) continue;
				const timeStr = tsMatch[1];

				// Extract request "METHOD /path HTTP/..."
				const reqMatch = line.match(/\"(?:GET|HEAD|POST|PUT|DELETE|OPTIONS|PATCH) ([^\s]+)[^\"]*\"/i);
				if (!reqMatch) continue;
				const request = reqMatch[1];

				// Try to find an upstream address at end if present (in quotes) - optional
				let upstreamAddr = null;
				const parts = line.split('"');
				if (parts.length >= 7) {
					// common combined format has upstream in the last quoted field
					upstreamAddr = parts[parts.length - 2] || null;
				}

				// Parse timestamp like: 06/Sep/2025:12:34:56 +0000 or with other timezone offsets
				const dateMatch = timeStr.match(/(\d{1,2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})\s*([+-]\d{4})?/);
				if (!dateMatch) continue;
				const [, day, month, year, hour, minute, second] = dateMatch;
				const monthNames = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
				const monthNum = monthNames[month] || 0;
				const time = new Date(year, monthNum, day, hour, minute, second).getTime();

				if (time >= startTime) {
					// Determine project name for this request. Prefer upstream IP mapping.
					let project = null;
					if (upstreamAddr && upstreamAddr !== '-') {
						const ip = (upstreamAddr || '').split(':')[0];
						if (ipToProject[ip]) project = ipToProject[ip];
					}
					// Fallback: use first path segment only if it matches a known project name
					if (!project) {
						const candidate = (request.split('/')[1] || '').trim();
						if (candidate && projectNames.has(candidate)) project = candidate;
					}

					// Only count requests that map to a known project
					if (!project) continue;

					if (!services[project]) services[project] = new Array(timeSlots.length).fill(0);
					const slotIndex = Math.floor((time - startTime) / intervalMs);
					if (slotIndex >= 0 && slotIndex < timeSlots.length) {
						services[project][slotIndex]++;
					}
				}
			} catch (e) {
				// ignore malformed lines
				continue;
			}
		}
		
		// create labels
		const labels = timeSlots.map(slot => new Date(slot).toLocaleString());
		
		res.json({ services, labels });
	} catch (e) {
		res.status(500).json({ error: String(e) });
	}
});

// simple auth
const sessions = new Map();
const ADMIN_PASS = process.env.ADMIN_PASSWORD || '塮䀿萊䚿䒾㺵䩟劅僎蔤ꉏ么잤쏮⦷肝㢣沈ᆫ䛞切ⴚ圂㉱隼瀛⟍续蹺茼⩈搲㵛ꖤ∲䨉'; // Use environment variable

// Rate limiting for authentication attempts
const authAttempts = new Map();
const MAX_AUTH_ATTEMPTS = 5;
const AUTH_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

app.post('/api/login', (req, res) => {
	const clientIP = req.ip || req.connection.remoteAddress;
	const now = Date.now();
	
	// Clean up old attempts
	for (const [ip, attemptsList] of authAttempts.entries()) {
		const recent = attemptsList.filter(attempt => now - attempt < AUTH_WINDOW_MS);
		if (recent.length === 0) {
			authAttempts.delete(ip);
		} else {
			authAttempts.set(ip, recent);
		}
	}
	
	// Check rate limiting
	const attempts = authAttempts.get(clientIP) || [];
	if (attempts.length >= MAX_AUTH_ATTEMPTS) {
		return res.status(429).json({ error: 'Too many authentication attempts. Try again later.' });
	}
	
	const { password } = req.body;
	if (!password || typeof password !== 'string') {
		attempts.push(now);
		authAttempts.set(clientIP, attempts);
		return res.status(400).json({ error: 'Password required' });
	}
	
	if (password === ADMIN_PASS) {
		// generate 32 random bytes in a way that's compatible across environments
		let rndBuf;
		try {
			if (typeof require === 'function') {
				rndBuf = require('crypto').randomBytes(32);
			} else if (globalThis && globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
				const arr = new Uint8Array(32);
				globalThis.crypto.getRandomValues(arr);
				rndBuf = Buffer.from(arr);
			} else {
				// fallback (not cryptographically strong)
				const arr = new Uint8Array(32);
				for (let i = 0; i < 32; i++) arr[i] = Math.floor(Math.random() * 256);
				rndBuf = Buffer.from(arr);
			}
			const token = rndBuf.toString('hex');
			sessions.set(token, { created: now, ip: clientIP });
			res.json({ token });
		} catch (err) {
			console.error('Failed to generate token', err);
			return res.status(500).json({ error: 'Failed to generate token' });
		}
	} else {
		attempts.push(now);
		authAttempts.set(clientIP, attempts);
		res.status(401).json({ error: 'Invalid password' });
	}
});

function authMiddleware(req, res, next) {
	const token = req.headers.authorization || req.query.token;
	const session = sessions.get(token);
	
	if (!session) {
		return res.status(401).json({ error: 'Unauthorized' });
	}
	
	const now = Date.now();
	const SESSION_TIMEOUT = 24 * 60 * 60 * 1000; // 24 hours
	
	// Check session expiration
	if (now - session.created > SESSION_TIMEOUT) {
		sessions.delete(token);
		return res.status(401).json({ error: 'Session expired' });
	}
	
	// Optional: Check IP consistency for additional security
	if (req.ip && session.ip && req.ip !== session.ip) {
		sessions.delete(token);
		return res.status(401).json({ error: 'Session invalidated due to IP change' });
	}
	
	// Update session timestamp
	session.created = now;
	next();
}

// protect all /api/* except /api/login and /api/stats
app.use('/api/', (req, res, next) => {
	if (req.path === '/login' || req.path === '/stats' || req.path === '/mapper') {
		return next();
	}
	authMiddleware(req, res, next);
});

if (process.env.SINGLE_RUN) {
	// await a single run to finish and then exit cleanly
	runner().then(() => {
		log('single run finished');
		process.exit(0);
	}).catch(err => {
		log('single run error', err && err.stack ? err.stack : err);
		process.exit(1);
	});
} else {
	// normal continuous mode
	runner();
	setInterval(runner, SCAN_INTERVAL_MS);
}

