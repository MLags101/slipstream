# Solving on your own mesh

WindTunnel normally meshes your STL with snappyHexMesh. If you already have a volume mesh
you trust (from Gmsh, Fluent Meshing, ICEM, Pointwise, or a finished OpenFOAM case), you can
skip that step and solve on it directly.

Open **New run → "import a Gmsh, Fluent or OpenFOAM mesh"** (under the sample links).

## Supported files

| Format | What to upload | Converted with |
|---|---|---|
| Gmsh | `.msh`, **version 2 ASCII** (Gmsh: File → Export → `.msh`, "Version 2 ASCII"). Name your boundary surfaces with Physical Groups. | `gmshToFoam` |
| Fluent | ASCII `.msh` or `.cas` | `fluent3DMeshToFoam` |
| OpenFOAM | a `.zip` containing a `constant/polyMesh` folder (binary or ASCII, `.gz` files are fine) | none needed |

Only 3D meshes are supported (no `empty` patches).

## Steps

1. **Pick the file and its units.** The mesh is converted, scaled to meters, and checked
   with `checkMesh`. A mesh that fails some checks can still be run; the failed count is
   shown so you can decide.
2. **Give every boundary patch a role.** WindTunnel suggests one from the patch names:

   | Role | Boundary condition |
   |---|---|
   | inlet | fixed freestream velocity along +X, turbulence from 1% intensity |
   | outlet | fixed pressure, outflow |
   | model | no-slip wall with wall functions; **forces, Cd and surface pressure come from these patches** |
   | tunnel wall (slip) | frictionless wall, like WindTunnel's own tunnel sides |
   | wall (no-slip) | no-slip wall with wall functions that isn't part of the model, e.g. a floor |
   | symmetry plane | mirror plane (must be flat) |

   You need at least one inlet, outlet and model patch.
3. **Set the wind speed and solver budget** (250, 500 or 800 iterations; runs still stop
   early once Cd settles) and run.

## Things to know

- **The wind blows along +X.** The inlet must be at the low-x end of the domain and the
  outlet at the high-x end; the import refuses a mesh where they're the other way around.
  Rotate the mesh in your mesher if needed.
- **Frontal area and the 3D view come from the model patches**, so the reference area is
  the frontal area of the meshed surface. Set a reference area to override it.
- **Blockage is up to you.** WindTunnel sizes its own tunnel so the model blocks under 5% of
  it; an imported domain is used as-is.
- Imported runs support re-solve (new wind speed on the same mesh) and re-run. Yaw/pitch
  sweeps, props, trim, symmetry and refinement options apply only to STL runs, since they
  change the geometry or the mesh.

## Checked against WindTunnel's own mesh

The same 256k-cell quad frame mesh was solved from an STL and then imported back in:

| Mesh source | Cells | Frontal area | Cd |
|---|---|---|---|
| WindTunnel meshed the STL | 256,439 | 41.68 cm² | 1.159 |
| Imported as a zipped polyMesh | 256,439 | 41.68 cm² | 1.168 |
| Exported to Fluent `.msh` and imported | 256,439 | 41.68 cm² | 1.169 |

The small Cd differences come from where the solver's automatic convergence stop landed,
not from the import: the zipped import stopped at iteration 157 (the Fluent one at 178), and over those same
iterations the original run's own Cd averaged 1.174 (it drifts between 1.151 and 1.182
from iteration 126 to 210 on this frame).
A 0.2 m cube meshed in Gmsh (16k hexahedra) also imported and solved: Cd 1.11 against about
1.05 measured for a cube.
