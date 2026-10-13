#!/bin/bash
# Keep host OpenSSL defaults from adding a second copy of a certificate extension.
set -euo pipefail
directory="${1:?Expected a private fixture directory}"
umask 077
cat >"$directory/ca.cnf" <<'CONFIG'
[req]
prompt = no
distinguished_name = dn
x509_extensions = ca_extensions
[dn]
CN = Remote tunnel test CA
[ca_extensions]
basicConstraints = critical,CA:true,pathlen:0
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
CONFIG
cat >"$directory/leaf.cnf" <<'CONFIG'
[req]
prompt = no
distinguished_name = dn
[dn]
CN = core.test
[leaf_extensions]
subjectAltName = DNS:core.test,IP:127.0.0.1
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid,issuer
CONFIG
openssl ecparam -name prime256v1 -genkey -noout -out "$directory/ca-key.pem"
openssl req -new -x509 -sha256 -config "$directory/ca.cnf" \
  -key "$directory/ca-key.pem" -out "$directory/ca.pem" -days 1
openssl ecparam -name prime256v1 -genkey -noout -out "$directory/key.pem"
openssl req -new -sha256 -config "$directory/leaf.cnf" \
  -key "$directory/key.pem" -out "$directory/leaf.csr"
openssl x509 -req -sha256 -in "$directory/leaf.csr" \
  -CA "$directory/ca.pem" -CAkey "$directory/ca-key.pem" \
  -set_serial 1 -out "$directory/leaf.pem" -days 1 \
  -extfile "$directory/leaf.cnf" -extensions leaf_extensions
cat "$directory/leaf.pem" "$directory/ca.pem" >"$directory/cert.pem"
