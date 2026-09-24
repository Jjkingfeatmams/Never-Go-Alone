# Publier la V3 live sur Netlify

Cette V3 contient désormais la page, les images, une Netlify Function et un
stockage persistant Netlify Blobs pour les profils intéressés. Les groupes
restent donc remplis après une nouvelle publication.

## Publication

1. Importer ce dépôt dans Netlify depuis Git (ne pas déposer seulement
   `index.html`, car les Functions ne seraient pas publiées).
2. Si le dépôt complet est importé, conserver la configuration détectée : elle
   utilise `v3` comme dossier de base. Si seul le dossier `v3` est importé,
   sa propre configuration `v3/netlify.toml` sera utilisée.
3. Déclencher le déploiement. La commande est `npm run build` et le dossier
   publié est `dist`.
4. Dans **Site configuration → Environment variables**, ajouter de préférence
   `INTEREST_HASH_SECRET` avec une longue valeur aléatoire privée. Ne pas
   modifier cette valeur après les premières inscriptions, car elle protège
   les liens de retrait des profils.

Les routes `/api/*` sont traitées par `netlify/functions/live-interest.mjs`.
Elles enregistrent seulement le prénom, l'activité et un avatar illustré qui
peuvent être affichés publiquement. L'e-mail, le nom et le genre ne sont pas
conservés dans le stockage partagé.

Pour protéger l'accès au prototype, activer la protection du site dans les
réglages Netlify plutôt que de mettre un mot de passe dans le code source.
