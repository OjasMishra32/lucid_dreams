# Asset credits

Every third-party asset the Lucid Dreams site ships, where it came from, and its license.

| File | What | Source | Author | License |
| --- | --- | --- | --- | --- |
| `chess_set.glb` | The chess set in the Play section (real size, 55 cm board) | [Poly Haven: Chess Set](https://polyhaven.com/a/chess_set), 1k glTF from `https://api.polyhaven.com/files/chess_set` | Riley Queen | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |

`chess_set.glb` was repacked from the 1k glTF with glTF Transform (`gltf-transform optimize --compress meshopt
--texture-compress webp --texture-size 1024 --simplify false --join false --instance false --flatten false`): same
geometry and pieces, WebP textures, 7 MB down to 0.95 MB.

The sample person (`../people/synthetic-test.spz`) is our own: frame 0 of the synthetic test bundle the Lucid Dreams
pipeline generates (`samples/synthetic-test` in this repo), MIT like the rest of the project.
