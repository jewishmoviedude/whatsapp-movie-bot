Drop your network filter's root CA certificate in this folder.

This network runs a TLS-intercepting content filter ("filter CA"). Every
HTTPS connection to the outside world is re-signed by that appliance, so
Node.js rejects it as untrusted unless the appliance's root certificate is
installed here.

Symptoms when it is missing:
  - "unable to get local issuer certificate"
  - "self-signed certificate in certificate chain"
  - OMDb / TMDB lookups fail, npm install fails

Fix:
  1. Get the root CA certificate from whoever runs your filter.
     It is usually offered as a .crt or .pem download from the filter's
     admin portal, or supplied by the provider on request.
  2. Save it in this folder, e.g. certs/filter-ca.crt  (PEM format,
     starts with -----BEGIN CERTIFICATE-----)
  3. Restart the bot. start.sh picks up every .crt/.pem here automatically.

To also fix npm and the rest of the system:
     sudo cp certs/filter-ca.crt /usr/local/share/ca-certificates/
     sudo update-ca-certificates
     npm config set cafile /etc/ssl/certs/ca-certificates.crt

Alternative: ask the filter provider to bypass interception for this
server's IP, which avoids needing the certificate at all.
