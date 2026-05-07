# Literature Database Search Strategies

This document provides comprehensive guidance for searching multiple literature databases systematically and effectively.

## Available Databases and Skills

### Biomedical & Life Sciences

#### PubMed / PubMed Central

- **Access**: Use WebFetch tool or direct API
- **Coverage**: 35M+ citations in biomedical literature
- **Best for**: Clinical studies, biomedical research, genetics, molecular biology
- **Search tips**: Use MeSH terms, Boolean operators (AND, OR, NOT), field tags [Title], [Author]
- **Example**: `"CRISPR"[Title] AND "gene editing"[Title/Abstract] AND 2020:2024[Publication Date]`

#### bioRxiv / medRxiv

- **Access**: Use direct API or WebFetch
- **Coverage**: Preprints in biology and medicine
- **Best for**: Latest unpublished research, cutting-edge findings
- **Note**: Not peer-reviewed; verify findings with caution
- **Search tips**: Search by category (bioinformatics, genomics, etc.)

### General Scientific Literature

#### arXiv

- **Access**: Direct API access
- **Coverage**: Preprints in physics, mathematics, computer science, quantitative biology
- **Best for**: Computational methods, bioinformatics algorithms, theoretical work
- **Categories**: q-bio (Quantitative Biology), cs.LG (Machine Learning), stat.ML (Statistics)
- **Search format**: `cat:q-bio.QM AND title:"single cell"`

#### Semantic Scholar

- **Access**: Direct API (requires API key)
- **Coverage**: 200M+ papers across all fields
- **Best for**: Cross-disciplinary searches, citation graphs, paper recommendations
- **Features**: Influential citations, paper summaries, related papers
- **Rate limits**: 100 requests/5 minutes with API key

#### Google Scholar

- **Access**: Web scraping (use cautiously) or manual search
- **Coverage**: Comprehensive across all fields
- **Best for**: Finding highly cited papers, conference proceedings, theses
- **Limitations**: No official API, rate limiting
- **Export**: Use "Cite" feature for formatted citations

### Specialized Databases

#### ChEMBL / PubChem

- **Access**: Use direct API or WebFetch tool
- **Coverage**: Chemical compounds, bioactivity data, drug molecules
- **Best for**: Drug discovery, chemical biology, medicinal chemistry
- **ChEMBL**: 2M+ compounds, bioactivity data
- **PubChem**: 110M+ compounds, assay data

#### UniProt

- **Access**: Use direct API or WebFetch tool
- **Coverage**: Protein sequence and functional information
- **Best for**: Protein research, sequence analysis, functional annotations
- **Search by**: Protein name, gene name, organism, function

#### KEGG (Kyoto Encyclopedia of Genes and Genomes)

- **Access**: Use direct API or WebFetch tool
- **Coverage**: Pathways, diseases, drugs, genes
- **Best for**: Pathway analysis, systems biology, metabolic research

#### COSMIC (Catalogue of Somatic Mutations in Cancer)

- **Access**: Use direct download or WebFetch tool
- **Coverage**: Cancer genomics, somatic mutations
- **Best for**: Cancer research, mutation analysis

#### AlphaFold Database

- **Access**: Use WebFetch tool on AlphaFold website
- **Coverage**: 200M+ protein structure predictions
- **Best for**: Structural biology, protein modeling

#### PDB (Protein Data Bank)

- **Access**: Use direct API or WebFetch tool
- **Coverage**: Experimental 3D structures of proteins, nucleic acids
- **Best for**: Structural biology, drug design, molecular modeling

### Citation & Reference Management

#### OpenAlex

- **Access**: Direct API (free, no key required)
- **Coverage**: 250M+ works, comprehensive metadata
- **Best for**: Citation analysis, author disambiguation, institutional research
- **Features**: Open access, excellent for bibliometrics

#### Dimensions

- **Access**: Free tier available
- **Coverage**: Publications, grants, patents, clinical trials
- **Best for**: Research impact, funding analysis, translational research

---

## Search Strategy Framework

### 1. Define Research Question (PICO Framework)

For clinical/biomedical reviews:

- **P**opulation: Who is the study about?
- **I**ntervention: What is being tested?
- **C**omparison: What is it compared to?
- **O**utcome: What are the results?

**Example**: "What is the efficacy of CRISPR-Cas9 gene therapy (I) for treating sickle cell disease (P) compared to standard care (C) in improving patient outcomes (O)?"

### 2. Develop Search Terms

#### Primary Concepts

Identify 2-4 main concepts from your research question.

**Example**:

- Concept 1: CRISPR, Cas9, gene editing
- Concept 2: sickle cell disease, SCD, hemoglobin disorders
- Concept 3: gene therapy, therapeutic editing

#### Synonyms & Related Terms

List alternative terms, abbreviations, and related concepts.

**Tool**: Use MeSH (Medical Subject Headings) browser for standardized terms

#### Boolean Operators

- **AND**: Narrows search (must include both terms)
- **OR**: Broadens search (includes either term)
- **NOT**: Excludes terms

**Example**: `(CRISPR OR Cas9 OR "gene editing") AND ("sickle cell" OR SCD) AND therapy`

#### Wildcards & Truncation

- `*` or `%`: Matches any characters
- `?`: Matches single character

**Example**: `genom*` matches genomic, genomics, genome

### 3. Set Inclusion/Exclusion Criteria

#### Inclusion Criteria

- **Date range**: e.g., 2015-2024 (last 10 years)
- **Language**: English (or specify multilingual)
- **Publication type**: Peer-reviewed articles, reviews, preprints
- **Study design**: RCTs, cohort studies, meta-analyses
- **Population**: Human, animal models, in vitro

#### Exclusion Criteria

- Case reports (n<5)
- Conference abstracts without full text
- Non-original research (editorials, commentaries)
- Duplicate publications
- Retracted articles

### 4. Database Selection Strategy

#### Multi-Database Approach

Search at least 3 complementary databases:

1. **Primary database**: PubMed (biomedical) or arXiv (computational)
2. **Preprint server**: bioRxiv/medRxiv or arXiv
3. **Comprehensive database**: Semantic Scholar or Google Scholar
4. **Specialized database**: ChEMBL, UniProt, or field-specific

#### Database-Specific Syntax

| Database         | Field Tags                | Example                                |
| ---------------- | ------------------------- | -------------------------------------- |
| PubMed           | [Title], [Author], [MeSH] | "CRISPR"[Title] AND 2020:2024[DP]      |
| arXiv            | ti:, au:, cat:            | ti:"machine learning" AND cat:q-bio.QM |
| Semantic Scholar | title:, author:, year:    | title:"deep learning" year:2020-2024   |

---

## Search Execution Workflow

### Phase 1: Pilot Search

1. Run initial search with broad terms
2. Review first 50 results for relevance
3. Note common keywords and MeSH terms
4. Refine search strategy

### Phase 2: Comprehensive Search

1. Execute refined searches across all selected databases
2. Export results in standard format (RIS, BibTeX, JSON)
3. Document search strings and date for each database
4. Record number of results per database

### Phase 3: Deduplication

1. Import all results into a single file
2. Deduplicate manually by DOI (primary) or title (fallback)
3. Identify duplicates by DOI (primary) or title (fallback)
4. Keep the version with most complete metadata

### Phase 4: Screening

1. **Title screening**: Review titles, exclude obviously irrelevant
2. **Abstract screening**: Read abstracts, apply inclusion/exclusion criteria
3. **Full-text screening**: Obtain and review full texts
4. Document reasons for exclusion at each stage

### Phase 5: Quality Assessment

1. Assess study quality using appropriate tools:
   - **RCTs**: Cochrane Risk of Bias tool
   - **Observational**: Newcastle-Ottawa Scale
   - **Systematic reviews**: AMSTAR 2
2. Grade quality of evidence (high, moderate, low, very low)
3. Consider excluding very low-quality studies

---

## Search Documentation Template

### Required Documentation

All searches must be documented for reproducibility:

```markdown
## Search Strategy

### Database: PubMed

- **Date searched**: 2024-10-25
- **Date range**: 2015-01-01 to 2024-10-25
- **Search string**:
```

("CRISPR"[Title] OR "Cas9"[Title] OR "gene editing"[Title/Abstract])
AND ("sickle cell disease"[MeSH] OR "SCD"[Title/Abstract])
AND ("gene therapy"[MeSH] OR "therapeutic editing"[Title/Abstract])
AND 2015:2024[Publication Date]
AND English[Language]

```
- **Results**: 247 articles
- **After deduplication**: 189 articles

### Database: bioRxiv
- **Date searched**: 2024-10-25
- **Date range**: 2015-01-01 to 2024-10-25
- **Search string**: "CRISPR" AND "sickle cell" (in title/abstract)
- **Results**: 34 preprints
- **After deduplication**: 28 preprints

### Total Unique Articles
- **Combined results**: 217 unique articles
- **After title screening**: 156 articles
- **After abstract screening**: 89 articles
- **After full-text screening**: 52 articles included in review
```

---

## Advanced Search Techniques

### Citation Chaining

#### Forward Citation Search

Find papers that cite a key paper:

- Use Google Scholar "Cited by" feature
- Use OpenAlex or Semantic Scholar APIs
- Identifies newer research building on seminal work

#### Backward Citation Search

Review references in key papers:

- Extract references from included papers
- Search for highly cited references
- Identifies foundational research

### Snowball Sampling

1. Start with 3-5 highly relevant papers
2. Extract all their references
3. Check which references are cited by multiple papers
4. Review those high-overlap references
5. Repeat for newly identified key papers

### Author Search

Follow prolific authors in the field:

- Search by author name across databases
- Check author profiles (ORCID, Google Scholar)
- Review recent publications and preprints

### Related Article Features

Many databases suggest related articles:

- PubMed "Similar articles"
- Semantic Scholar "Recommended papers"
- Use to discover papers missed by keyword search

---

## Quality Control Checklist

### Before Searching

- [ ] Research question clearly defined
- [ ] PICO criteria established (if applicable)
- [ ] Search terms and synonyms listed
- [ ] Inclusion/exclusion criteria documented
- [ ] Target databases selected (minimum 3)
- [ ] Date range determined

### During Searching

- [ ] Search string tested and refined
- [ ] Results exported with complete metadata
- [ ] Search parameters documented
- [ ] Number of results recorded per database
- [ ] Search date recorded

### After Searching

- [ ] Duplicates removed
- [ ] Screening protocol followed
- [ ] Reasons for exclusion documented
- [ ] Quality assessment completed
- [ ] All citations verified with webfetch
- [ ] Search methodology documented in review

---

## Common Pitfalls to Avoid

1. **Too narrow search**: Missing relevant papers
   - Solution: Include synonyms, related terms, broader concepts

2. **Too broad search**: Thousands of irrelevant results
   - Solution: Add specific concepts with AND, use field tags

3. **Single database**: Incomplete coverage
   - Solution: Search minimum 3 complementary databases

4. **Ignoring preprints**: Missing latest findings
   - Solution: Include bioRxiv, medRxiv, or arXiv

5. **No documentation**: Irreproducible search
   - Solution: Document every search string, date, and result count

6. **Manual deduplication**: Time-consuming and error-prone
   - Solution: Deduplicate manually by DOI and title

7. **Unverified citations**: Broken DOIs, incorrect metadata
   - Solution: Verify each citation URL with webfetch

8. **Publication bias**: Only including published positive results
   - Solution: Search trial registries, contact authors for unpublished data

---

## Example Multi-Database Search Workflow

```python
# Example workflow using available tools

# 1. Search PubMed via websearch or alpha-research
search_term = "CRISPR AND sickle cell disease"

# 2. Search bioRxiv via websearch

# 3. Search arXiv via arxiv-search skill
# Search arXiv with: cat:q-bio AND "CRISPR" AND "sickle cell"

# 4. Search Semantic Scholar via API
# Use semantic scholar API with search query

# 5. Aggregate and deduplicate results manually
# Track DOIs and titles to identify duplicates

# 6. Verify all citations with webfetch
# Check each URL resolves correctly

# 7. Generate final PDF
# 7. Format final output in markdown
```

```

---

## Resources

### MeSH Browser

https://meshb.nlm.nih.gov/search

### Boolean Search Tutorial

https://www.ncbi.nlm.nih.gov/books/NBK3827/

### Citation Style Guides

See references/citation_styles.md in this skill

### PRISMA Guidelines

Preferred Reporting Items for Systematic Reviews and Meta-Analyses:
http://www.prisma-statement.org/
```
