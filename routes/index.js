const express = require('express');
const CURRENT_PROGRESS = require('../rtmp-center-ad');

const router = express.Router();

/* GET home page. */
router.get('/', async (req, res, next) => {
  const urls = Array.from(CURRENT_PROGRESS.publishers.keys());
  const ids = [];
  console.log(urls);
  for (const url of urls) {
    console.log(url);
    const parsedUrl = url.split('/');
    ids.push(parsedUrl[parsedUrl.length - 1]);
  }
  console.log(ids);
  res.render('index', { urls, ids });
});

router.get('/live/:id', (req, res, next) => {
  const id = req.params.id;
  const url = `/${id}`;
  console.log(`id = ${id}`);
  console.log(`url = ${url}`);
  res.render('streaming', { id, url });
});

module.exports = router;
