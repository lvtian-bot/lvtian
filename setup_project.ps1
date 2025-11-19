# Setup Project Script for MD Notes

Write-Host "Setting up MD Notes Project..."

# Install dependencies
Write-Host "Installing dependencies..."
npm install

# Android Setup
Write-Host "Setting up Android..."
# Note: React Native 0.60+ auto-links, but sometimes manual steps are needed for specific libs if not using Expo.
# For this bare workflow, we rely on auto-linking.

Write-Host "Setup Complete! You can now run 'npm run android' to start the app."
