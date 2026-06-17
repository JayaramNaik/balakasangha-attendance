# Balakasangha Attendance — Static app

This repository contains a static HTML attendance tracker that stores data in the browser (`localStorage`) and supports exporting to Excel.

How to publish on GitHub Pages

1. Create a new GitHub repository (e.g. `balakasangha-attendance`).
2. From your local folder (`Attendence_tracker`) initialize git and push:

```bash
git init
git add .
git commit -m "Initial commit: attendance app"
git branch -M main
git remote add origin https://github.com/<your-username>/<repo>.git
git push -u origin main
```

3. In the GitHub repository go to Settings → Pages, and select `main` branch and `/ (root)` folder, then Save. The site will be available at `https://<your-username>.github.io/<repo>/` — `index.html` redirects to the app.

Notes
- Data is stored locally in each user's browser (`localStorage`). Exports are generated client-side as Excel files.
- To move data between machines: use the Export Excel button or copy the `localStorage` JSON (I can add a backup/restore button if you want).

If you want shared storage (multiple users sharing the same data), I can add a tiny backend and deploy it instead.
