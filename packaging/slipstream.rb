# Homebrew cask for Slipstream.
#
# To publish: create a public repo named `homebrew-slipstream` under your
# GitHub account, put this file at Casks/slipstream.rb, and update the
# version/sha256 on each release (sha256 is printed by the release workflow).
# Users then install with:
#   brew install --cask --no-quarantine OwenTWebb/slipstream/slipstream
cask "slipstream" do
  version "0.1.0"
  sha256 "REPLACE_WITH_SHA256_FROM_RELEASE_WORKFLOW"

  url "https://github.com/OwenTWebb/windtunnel/releases/download/v#{version}/Slipstream-v#{version}-macos-arm64.zip"
  name "Slipstream"
  desc "Virtual wind tunnel: drop an STL, get OpenFOAM CFD analysis"
  homepage "https://github.com/OwenTWebb/windtunnel"

  depends_on cask: "gerlero/openfoam/openfoam"
  depends_on arch: :arm64

  app "Slipstream.app"

  zap trash: ["~/.slipstream", "~/.windtunnel"]

  caveats <<~EOS
    Slipstream is unsigned (free, open-source project). If you installed
    without --no-quarantine, allow it once via System Settings ->
    Privacy & Security -> "Open Anyway".
  EOS
end
