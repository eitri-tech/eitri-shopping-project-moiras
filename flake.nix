{
  description = "Moiras: plugin de triagem de épicos do Jira para Claude Code";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      devShells = forAllSystems (
        pkgs:
        let
          # Só tipos para o `tsc` e o editor: o Node roda os .ts sem eles e o plugin não depende disto.
          typesNode = pkgs.runCommand "types-node-24.19.1" { } ''
            mkdir -p $out/node
            tar -xzf ${
              pkgs.fetchurl {
                url = "https://registry.npmjs.org/@types/node/-/node-24.19.1.tgz";
                hash = "sha512-aS3/DG0oM05K0RIXXP+hKjinGG5IgSSVGzswZxW3O0sS3pH4/fycXundUC9XsszgKCk4gHXylTEK6hyFxVxnoQ==";
              }
            } -C $out/node --strip-components=1
          '';
        in
        {
          default = pkgs.mkShellNoCC {
            packages = [
              pkgs.nodejs # LTS mais recente do nixpkgs
              pkgs.typescript # só para checar tipos (tsc --noEmit)
              pkgs.python3
              pkgs.jq
            ];
            shellHook = ''
              if [ -f flake.nix ]; then
                mkdir -p .direnv
                ln -sfn ${typesNode} .direnv/types
              fi
            '';
          };
        }
      );

      formatter = forAllSystems (pkgs: pkgs.nixfmt);
    };
}
