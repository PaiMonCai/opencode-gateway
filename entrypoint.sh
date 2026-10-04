#!/bin/bash
set -e

PUID=${PUID:-1000}
PGID=${PGID:-1000}

if [ "$(id -g node)" -ne "$PGID" ]; then
    groupmod -o -g "$PGID" node
fi

if [ "$(id -u node)" -ne "$PUID" ]; then
    usermod -o -u "$PUID" node
fi

chown -R node:node /home/node/.local/share/opencode
chown -R node:node /home/node/.config/opencode
chown -R node:node /home/node/project

if [[ "${OPENCODE_PROXY_PROMPT_MODE:-standard}" == "plugin-inject" ]]; then
    echo "Preparing opencode-gateway plugin-inject prompt mode..."
    mkdir -p /home/node/.config/opencode/plugin/opencode-gateway-empty
    cat > /home/node/.config/opencode/plugin/opencode-gateway-empty/index.js <<'EOF'
export const OpencodeGatewayEmptyPlugin = async () => ({})
export default OpencodeGatewayEmptyPlugin
EOF
    cat > /home/node/.config/opencode/opencode.json <<'EOF'
{
  "plugin": ["/home/node/.config/opencode/plugin/opencode-gateway-empty/index.js"],
  "instructions": [],
  "theme": "system"
}
EOF
    chown -R node:node /home/node/.config/opencode
fi

# The proxy starts and supervises the OpenCode backend itself, so the backend
# always runs with the opencode-gateway tool-lock plugin that free models need.
exec gosu node "$@"
