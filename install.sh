#!/bin/bash

set -e

# Claude Proxy Switch installer
INSTALL_DIR="$HOME/.claude-proxy"
BIN_DIR="$INSTALL_DIR/bin"

echo "Installing Claude Proxy Switch..."

# Create installation directory
mkdir -p "$BIN_DIR"

# Remove stale runtime files from older installs before copying
rm -rf "$BIN_DIR"
mkdir -p "$BIN_DIR"

# Copy only runtime files
cp package.json package-lock.json README.md LICENSE "$INSTALL_DIR/"
cp bin/claude-proxy-switch.js "$BIN_DIR/"

# Install npm dependencies
cd "$INSTALL_DIR"
npm install --omit=dev

# Link the binary
npm link

echo
echo "✓ Installation complete!"
echo
echo "Try it out:"
echo "  claude-proxy --help"
echo
