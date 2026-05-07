# Literature Review Methodology Reference

## PICO Framework

Define research questions using PICO:

| Component            | Description                 | Example                            |
| -------------------- | --------------------------- | ---------------------------------- |
| **P** — Population   | Who/what is the subject     | Patients with sickle cell disease  |
| **I** — Intervention | What is being studied       | CRISPR-Cas9 gene therapy           |
| **C** — Comparison   | What is it compared against | Standard hydroxyurea treatment     |
| **O** — Outcome      | What is measured            | Reduction in vaso-occlusive crises |

Example: "What is the efficacy of CRISPR-Cas9 (I) for treating sickle cell disease (P) compared to standard care (C) in reducing crises (O)?"

## Search Strategy

1. Identify 2-4 main concepts from the research question
2. List synonyms, abbreviations, and related terms for each concept
3. Plan Boolean operators (AND, OR, NOT) to combine terms
4. Select minimum 3 complementary databases

### Database Selection by Domain

| Domain                     | Recommended databases                            |
| -------------------------- | ------------------------------------------------ |
| Biomedical & Life Sciences | PubMed/PMC, bioRxiv, Semantic Scholar            |
| Physics, Math, CS          | arXiv, Semantic Scholar, Google Scholar          |
| Cross-disciplinary         | Semantic Scholar, Google Scholar, Web of Science |
| Chemistry                  | ChEMBL, PubChem, Semantic Scholar                |
| Genomics                   | PubMed, GEO, Ensembl                             |

### Search Tips

- Use MeSH terms for PubMed: `"sickle cell disease"[MeSH]`
- Field tags: `[Title]`, `[Title/Abstract]`, `[Author]`
- Date filters: `2020:2024[Publication Date]`
- Boolean operators: AND, OR, NOT

## PRISMA Screening

Screen in progressive stages, documenting counts at each stage:

```
Initial search: n = X
├─ After deduplication: n = Y
├─ After title screening: n = Z
├─ After abstract screening: n = A
└─ Included in review: n = B
```

Record specific reasons for exclusion at each stage.

## Inclusion/Exclusion Criteria

Set before screening begins:

- Date range (e.g., last 10 years)
- Language (typically English)
- Publication types (peer-reviewed, preprints, reviews)
- Study designs (RCTs, observational, in vitro, etc.)

## Quality Assessment Tools

| Study type            | Assessment tool        |
| --------------------- | ---------------------- |
| RCTs                  | Cochrane Risk of Bias  |
| Observational studies | Newcastle-Ottawa Scale |
| Systematic reviews    | AMSTAR 2               |

Rate each study: High, Moderate, Low, or Very Low quality.

## Thematic Synthesis Principles

1. Organize by themes or research questions, NOT by individual studies
2. Synthesize findings across multiple studies within each theme
3. Compare and contrast different approaches and results
4. Identify consensus areas and points of controversy
5. Highlight the strongest evidence

Example:

```
Theme: CRISPR Delivery Methods

Multiple delivery approaches have been investigated. Viral vectors (AAV)
were used in 15 studies^1-15^ and showed high transduction efficiency
(65-85%) but raised immunogenicity concerns^3,7,12^. In contrast,
lipid nanoparticles demonstrated lower efficiency (40-60%) but improved
safety profiles^16-23^.
```

## Citation Chaining

Expand search via citation networks:

1. **Forward citations** (papers citing key papers): Use Google Scholar "Cited by", Semantic Scholar, or OpenAlex
2. **Backward citations** (references from key papers): Extract references from included papers, identify highly cited foundational work

## Citation Styles

Quick reference for common styles:

### APA (7th Edition)

- In-text: (Smith et al., 2023)
- Reference: Smith, J. D., Johnson, M. L., & Williams, K. R. (2023). Title. _Journal_, _22_(4), 301-318. https://doi.org/10.xxx/yyy

### Nature

- In-text: Superscript numbers^1,2^
- Reference: Smith, J. D., Johnson, M. L. & Williams, K. R. Title. _Nat. Rev. Drug Discov._ **22**, 301-318 (2023).

### Vancouver

- In-text: Superscript numbers^1,2^
- Reference: Smith JD, Johnson ML, Williams KR. Title. Nat Rev Drug Discov. 2023;22(4):301-18.

For detailed citation formatting, see `references/citation_styles.md`.
