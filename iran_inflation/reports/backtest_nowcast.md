# Backtest: month-1 inflation with month-1 FX known (nowcast mode)

Origins 1395-04..1405-06 (123). Units: 100 x log change in one month.
Outcomes for 1405-07 come from data/manual/sci_latest.csv.

## All months

| target | variant | n | bias (y-med) | MAE | cover80 % | mean PIT |
|---|---|---|---|---|---|---|
| food | pinned_hl24 | 123 | 0.16 | 1.87 | 66.67 | 0.50 |
| food | pinned_hl60 | 123 | 0.19 | 1.76 | 69.11 | 0.49 |
| food | simulated | 123 | 0.18 | 1.87 | 73.17 | 0.50 |
| total | pinned_hl24 | 123 | 0.10 | 0.88 | 68.29 | 0.51 |
| total | pinned_hl60 | 123 | 0.14 | 0.82 | 69.92 | 0.51 |
| total | simulated | 123 | 0.14 | 0.95 | 78.86 | 0.52 |


## Months with an FX jump (du > 8)

| target | variant | n | bias (y-med) | MAE | cover80 % | mean PIT |
|---|---|---|---|---|---|---|
| food | pinned_hl24 | 30 | 1.10 | 2.68 | 60.00 | 0.58 |
| food | pinned_hl60 | 30 | 1.25 | 2.68 | 63.33 | 0.60 |
| food | simulated | 30 | 1.94 | 2.86 | 63.33 | 0.68 |
| total | pinned_hl24 | 30 | 0.64 | 1.41 | 46.67 | 0.61 |
| total | pinned_hl60 | 30 | 0.67 | 1.31 | 60.00 | 0.59 |
| total | simulated | 30 | 1.37 | 1.61 | 60.00 | 0.74 |


## Since 1404-01

| target | variant | n | bias (y-med) | MAE | cover80 % | mean PIT |
|---|---|---|---|---|---|---|
| food | pinned_hl24 | 19 | -0.07 | 2.12 | 57.89 | 0.51 |
| food | pinned_hl60 | 19 | 0.17 | 2.05 | 63.16 | 0.51 |
| food | simulated | 19 | 0.39 | 2.55 | 68.42 | 0.51 |
| total | pinned_hl24 | 19 | 0.20 | 1.33 | 52.63 | 0.57 |
| total | pinned_hl60 | 19 | 0.27 | 1.20 | 57.89 | 0.55 |
| total | simulated | 19 | 0.40 | 1.47 | 68.42 | 0.55 |


## Last 6 months (headline)

| origin   | month   | variant     | target   |    du |    y |   median |   lo80 |   hi80 |   pit |
|:---------|:--------|:------------|:---------|------:|-----:|---------:|-------:|-------:|------:|
| 1405-01  | 1405-02 | pinned_hl60 | total    | 10.49 | 8.46 |     5.35 |   4.32 |   7.03 |  0.99 |
| 1405-01  | 1405-02 | pinned_hl24 | total    | 10.49 | 8.46 |     5.8  |   4.69 |   7.82 |  0.99 |
| 1405-01  | 1405-02 | simulated   | total    | 10.49 | 8.46 |     4.11 |   2.35 |   6.14 |  0.99 |
| 1405-02  | 1405-03 | pinned_hl60 | total    | -1.75 | 5.77 |     7.61 |   6.57 |   9.32 |  0.03 |
| 1405-02  | 1405-03 | pinned_hl24 | total    | -1.75 | 5.77 |     8.26 |   6.93 |   9.86 |  0.02 |
| 1405-02  | 1405-03 | simulated   | total    | -1.75 | 5.77 |     8.98 |   6.98 |  11.17 |  0.02 |
| 1405-03  | 1405-04 | pinned_hl60 | total    |  4.88 | 3.08 |     5.87 |   4.91 |   7.63 |  0    |
| 1405-03  | 1405-04 | pinned_hl24 | total    |  4.88 | 3.08 |     5.93 |   4.71 |   7.83 |  0.01 |
| 1405-03  | 1405-04 | simulated   | total    |  4.88 | 3.08 |     5.51 |   3.48 |   7.75 |  0.06 |
| 1405-04  | 1405-05 | pinned_hl60 | total    |  5.41 | 3.37 |     3.58 |   2.57 |   5.39 |  0.37 |
| 1405-04  | 1405-05 | pinned_hl24 | total    |  5.41 | 3.37 |     3.73 |   2.62 |   5.74 |  0.38 |
| 1405-04  | 1405-05 | simulated   | total    |  5.41 | 3.37 |     3.57 |   1.69 |   5.78 |  0.45 |
| 1405-05  | 1405-06 | pinned_hl60 | total    | 15.64 | 4.16 |     4.87 |   3.77 |   6.87 |  0.24 |
| 1405-05  | 1405-06 | pinned_hl24 | total    | 15.64 | 4.16 |     5.18 |   3.99 |   7.18 |  0.15 |
| 1405-05  | 1405-06 | simulated   | total    | 15.64 | 4.16 |     3.28 |   1.47 |   5.65 |  0.69 |
| 1405-06  | 1405-07 | pinned_hl60 | total    | 15.71 | 4.29 |     5.83 |   4.79 |   7.63 |  0.06 |
| 1405-06  | 1405-07 | pinned_hl24 | total    | 15.71 | 4.29 |     5.88 |   4.83 |   8.03 |  0.02 |
| 1405-06  | 1405-07 | simulated   | total    | 15.71 | 4.29 |     4.96 |   3.11 |   7.19 |  0.33 |
