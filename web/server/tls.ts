// Local HTTPS for QLMix: browsers only allow microphone access (room measurement) on secure pages.
//
// A small local certificate authority ("QLMix Local CA") is created once and has to be trusted on
// each phone (install profile → enable full trust). The server certificate is signed by that CA
// and re-issued automatically whenever the computer's IP addresses change – no re-install needed.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import forge from "node-forge";

export interface TlsMaterial {
  key: string;
  cert: string;   // server certificate + CA (chain)
  caCert: string; // for download / installation on phones
}

function localHosts(): { dns: string[]; ips: string[] } {
  const host = os.hostname().replace(/\.local$/i, "");
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter((i): i is os.NetworkInterfaceInfo => !!i && i.family === "IPv4")
    .map((i) => i.address);
  return { dns: ["localhost", host, `${host}.local`], ips: [...new Set(["127.0.0.1", ...ips])].sort() };
}

function newKeyPair(): { privateKey: forge.pki.rsa.PrivateKey; publicKey: forge.pki.rsa.PublicKey } {
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const priv = forge.pki.privateKeyFromPem(privateKey) as forge.pki.rsa.PrivateKey;
  return { privateKey: priv, publicKey: forge.pki.setRsaPublicKey(priv.n, priv.e) };
}

function serial(): string {
  return "01" + crypto.randomBytes(15).toString("hex");
}

function createCA(): { cert: forge.pki.Certificate; key: forge.pki.rsa.PrivateKey } {
  const keys = newKeyPair();
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600e3);
  cert.validity.notAfter = new Date(Date.now() + 10 * 365 * 24 * 3600e3);
  const attrs = [{ name: "commonName", value: `QLMix Local CA (${os.hostname()})` }, { name: "organizationName", value: "QLMix" }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
    { name: "subjectKeyIdentifier" },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { cert, key: keys.privateKey };
}

function createServerCert(ca: { cert: forge.pki.Certificate; key: forge.pki.rsa.PrivateKey }, hosts: { dns: string[]; ips: string[] }) {
  const keys = newKeyPair();
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600e3);
  cert.validity.notAfter = new Date(Date.now() + 800 * 24 * 3600e3); // iOS: max. 825 days
  cert.setSubject([{ name: "commonName", value: `QLMix (${os.hostname()})` }]);
  cert.setIssuer(ca.cert.subject.attributes);
  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true, critical: true },
    { name: "extKeyUsage", serverAuth: true },
    { name: "subjectAltName", altNames: [...hosts.dns.map((value) => ({ type: 2, value })), ...hosts.ips.map((ip) => ({ type: 7, ip }))] },
    { name: "subjectKeyIdentifier" },
    { name: "authorityKeyIdentifier", keyIdentifier: ca.cert.generateSubjectKeyIdentifier().getBytes() },
  ]);
  cert.sign(ca.key, forge.md.sha256.create());
  return { cert, key: keys.privateKey };
}

/** Loads or creates the CA and a server certificate valid for all current local addresses. */
export function ensureTls(dir: string): TlsMaterial {
  fs.mkdirSync(dir, { recursive: true });
  const caKeyFile = path.join(dir, "ca.key"), caCertFile = path.join(dir, "ca.crt");
  const keyFile = path.join(dir, "server.key"), certFile = path.join(dir, "server.crt"), metaFile = path.join(dir, "server.json");

  let ca: { cert: forge.pki.Certificate; key: forge.pki.rsa.PrivateKey };
  if (fs.existsSync(caKeyFile) && fs.existsSync(caCertFile)) {
    ca = {
      cert: forge.pki.certificateFromPem(fs.readFileSync(caCertFile, "utf8")),
      key: forge.pki.privateKeyFromPem(fs.readFileSync(caKeyFile, "utf8")) as forge.pki.rsa.PrivateKey,
    };
  } else {
    ca = createCA();
    fs.writeFileSync(caKeyFile, forge.pki.privateKeyToPem(ca.key), { mode: 0o600 });
    fs.writeFileSync(caCertFile, forge.pki.certificateToPem(ca.cert));
  }

  const hosts = localHosts();
  const wanted = JSON.stringify(hosts);
  let needNew = !fs.existsSync(keyFile) || !fs.existsSync(certFile) || !fs.existsSync(metaFile);
  if (!needNew) {
    const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
    const cert = forge.pki.certificateFromPem(fs.readFileSync(certFile, "utf8"));
    needNew = meta.hosts !== wanted || cert.validity.notAfter.getTime() - Date.now() < 30 * 24 * 3600e3;
  }
  if (needNew) {
    const server = createServerCert(ca, hosts);
    fs.writeFileSync(keyFile, forge.pki.privateKeyToPem(server.key), { mode: 0o600 });
    fs.writeFileSync(certFile, forge.pki.certificateToPem(server.cert));
    fs.writeFileSync(metaFile, JSON.stringify({ hosts: wanted, created: new Date().toISOString() }));
  }
  const caPem = forge.pki.certificateToPem(ca.cert);
  return { key: fs.readFileSync(keyFile, "utf8"), cert: fs.readFileSync(certFile, "utf8") + caPem, caCert: caPem };
}
