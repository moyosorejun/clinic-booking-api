require('dotenv').config({ quiet: true });
const app = require('./app');

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Clinic booking API running on http://localhost:${port}`);
});
