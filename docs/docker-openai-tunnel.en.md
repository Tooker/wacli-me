# wacli-me with Docker and OpenAI Secure MCP Tunnel

This Compose setup starts the wacli.me MCP server and the official OpenAI
tunnel client on a private Docker network. The server and tunnel status page
are reachable only through the host's `127.0.0.1`; the MCP port is not
publicly reachable.

The tunnel is bound to one wacli.me tenant. The tunnel client supplies that
tenant's bearer token internally before calling the MCP server.
The Compose file pins the official tunnel-client image to version `v0.0.15`
and its image digest.

## 1. Create the local configuration

From the repository directory:

```bash
cp .env.example .env
chmod 600 .env
mkdir -p stores logs
```

On Linux, set `WACLI_UID` and `WACLI_GID` in `.env` to the values from `id -u`
and `id -g`. This lets the container write to the bind-mounted data folders
while keeping the files editable by your user. With Docker Desktop, start with
the defaults.

Create an empty tenant list and save it as `config/tenants.json`:

```json
{
  "tenants": []
}
```

Git ignores this file.

## 2. Link the WhatsApp account locally

Start only the local server first:

```bash
docker compose -f docker-compose.tunnel.yml up -d --build wacli-me
```

Open [http://localhost:8787/connect](http://localhost:8787/connect) and link
your WhatsApp account with the QR code. Choose whether the server may send
messages; the checkbox starts enabled. The server adds the tenant and its
random token to `config/tenants.json`.

Set that tenant's token as `WACLI_ME_TENANT_TOKEN` in `.env`. Keep the same
value in `config/tenants.json`. Set `allowSend` to `true` there only if the MCP
server should be allowed to send messages.

## 3. Configure the OpenAI tunnel

Create a tunnel in
[OpenAI Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels)
and associate it with the ChatGPT workspace you plan to use. Set its ID as
`CONTROL_PLANE_TUNNEL_ID` in `.env`.

Set `CONTROL_PLANE_API_KEY` to a runtime key with Tunnels **Read + Use**. Do
not use an admin key with **Manage** for the long-running tunnel client.

## 4. Start the server and tunnel

```bash
docker compose -f docker-compose.tunnel.yml up -d --build
docker compose -f docker-compose.tunnel.yml ps
docker compose -f docker-compose.tunnel.yml logs --tail=100 -f tunnel-client
```

The tunnel status page is at
[http://localhost:8092/ui](http://localhost:8092/ui). Change `TUNNEL_UI_PORT`
in `.env` if that port is already in use.

In ChatGPT, create a developer app and choose **Connection → Tunnel**, then
select the new tunnel ID. The tunnel client supplies the wacli.me tenant token
locally; do not configure additional MCP bearer authentication for this
connection.

The tunnel client needs outbound HTTPS to OpenAI. No inbound firewall rule or
public MCP address is needed.

## Operation

Recreate the tunnel container after changing `.env`:

```bash
docker compose -f docker-compose.tunnel.yml up -d --force-recreate tunnel-client
```

Stop the services:

```bash
docker compose -f docker-compose.tunnel.yml down
```

The tunnel client reaches the MCP server over the Compose network. The host
port is restricted to `127.0.0.1`. For more WhatsApp accounts, use a separate
tunnel client with the matching tenant token and its own tunnel ID.
