# Rhythm Dock — server setup

The maintained deployment and Telegram guide is [server/README.md](../server/README.md).
Use the repository-root `server/` directory, not `Rhythm Dock/server/`.

See [TASKS.md](../TASKS.md) for deferred HTTPS/WSS, two-friend listening, Telegram
credentials, installer and device acceptance. Local loopback/mocked tests do not
check those deployment tasks off. The server's rooms and pending submissions are
temporary; a restart needs a new room and Telegram pairing. Desktop saved queues
and the optional bot polling-offset volume have separate persistence.
