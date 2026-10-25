# Public Gemma plan comparison

Generated on 2026-10-25 with `gemma4:e4b` through local Ollama. Each adjacent JSON file contains the cleaned Gemma plan and the objective comparison fields from the public hand-written `experience.json`. The public previews and original plans were read from `https://getluciddreams.vercel.app`; downloaded clips stayed in `/private/tmp`.

| Bundle | Hand-written plan | Gemma result | Recommendation for Ojasva |
| --- | --- | --- | --- |
| `dance-01` | Teach, 3 steps | Teach, 4 steps | Keep hand-written until a person reviews timing against the motion. |
| `golf-01` | Teach, 3 steps | Watch, no steps | Keep hand-written. |
| `taichi-01` | Teach, 3 steps | Teach, 4 steps, ahead, studio | Gemma is the stronger contract-aligned candidate; visually review its tips and boundaries before selection. |
| `guitar-01` | Teach, 3 steps | Teach, 3 steps, beside, concert hall, guitar | Gemma is the stronger contract-aligned candidate; visually review before selection. |
| `jump-shot-hq` | Teach, 3 steps | Teach, 4 steps | Keep hand-written until a person reviews the extra boundary and basketball context. |
| `lebron-shot` | Teach, 3 steps | Teach, 4 steps, ahead, court, basketball and hoop | Gemma is the stronger contract-aligned candidate; visually review before selection. |

None of these recommendations overwrites the deployed plan. The saved JSON makes every generated field auditable and records the model tag.
