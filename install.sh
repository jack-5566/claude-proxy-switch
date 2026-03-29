#!/bin/bash

set -e

# Claude Proxy Switch installer
INSTALL_DIR="$HOME/.claude-proxy"
BIN_DIR="$INSTALL_DIR/bin"

echo "Installing Claude Proxy Switch..."

# Create installation directory
mkdir -p "$BIN_DIR"

# Copy all files
cp -r ./* "$INSTALL_DIR/"

# Install npm dependencies
cd "$INSTALL_DIR"
npm install --production

# Link the binary
npm link

echo
echo "✓ Installation complete!"
echo
echo "Try it out:"
echo "  claude-proxy --help"
echo
