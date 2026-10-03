# Running the feed crawl on your Windows PC

braintreevansales.co.uk blocks anything that isn't a real web browser, so the nightly crawl runs on your own PC and opens pages in your installed **Google Chrome**, the same way you would. It reads the stock, then updates the feed that Google Merchant Center collects. Set-up takes about 20 minutes, once.

The PC needs to be switched on, awake, online and **signed in to Windows** at the scheduled time (step 7 catches up if it was off). A Chrome window sits minimised in the taskbar while the crawl runs. Leave it alone.

## 1. Install Node.js (and check you have Chrome)
1. Go to <https://nodejs.org> and click the green **LTS** download button.
2. Open the downloaded file and click Next through the installer, leaving every option as it is. Click Finish.
3. Check it worked: press the Windows key, type `cmd`, press Enter, type `node -v` and press Enter. You should see a number starting with `v22` or higher. Close the window.
4. Google Chrome must be installed in the normal way (<https://www.google.com/chrome>). Nothing else is downloaded for it.

## 2. Download the project
1. Sign in to GitHub in your browser and open <https://github.com/DavidFriendIO/bvs-vehicle-feed>.
2. Click the green **Code** button, then **Download ZIP**.
3. Open the ZIP in your Downloads folder, right-click it and choose **Extract All**. Extract to `C:\`.
4. Rename the folder it creates (`bvs-vehicle-feed-main`) to `bvs-vehicle-feed`, so you have `C:\bvs-vehicle-feed`.
5. Open that folder. You should see `run-crawl.bat` straight inside it. If you only see another folder, you've gone one level too deep: move the contents up.

## 3. Get your three Cloudflare values
Open <https://dash.cloudflare.com> and sign in. Menu names change now and then; if one looks different, look for the closest match. Copy each value into Notepad as you go.

**CF_ACCOUNT_ID**
1. Click **Workers & Pages** in the left menu.
2. On the right-hand side, find **Account ID** and click the copy icon. (It is 32 letters and numbers. It's also the long code in the browser address bar just after `dash.cloudflare.com/`.)

**CF_KV_NAMESPACE_ID**
1. In the left menu click **Storage & Databases**, then **KV**.
2. Find the namespace used by the feed. It's the one with `bvs-vehicle-feed` in its name (for example `bvs-vehicle-feed-BVS_FEED`).
3. Copy its **ID** from the table (32 letters and numbers).

**CF_API_TOKEN**
1. Click your profile picture (top right), then **My Profile**, then **API Tokens** on the left.
2. Click **Create Token**, then **Create Custom Token**.
3. Token name: `bvs feed crawl`.
4. Under **Permissions**, choose **Account**, then **Workers KV Storage**, then **Edit**.
5. Under **Account Resources**, choose **Include**, then your account.
6. Click **Continue to summary**, then **Create Token**.
7. Copy the token shown on the screen straight away. Cloudflare only shows it once. If you lose it, make a new one.

## 4. Fill in the `.env` settings file
1. Open `C:\bvs-vehicle-feed` and double-click `.env.example`. If Windows asks what to open it with, choose **Notepad**.
2. After each `=` sign paste the matching value, with no spaces and no quotes. For example:
   ```
   CF_ACCOUNT_ID=0123456789abcdef0123456789abcdef
   CF_KV_NAMESPACE_ID=fedcba9876543210fedcba9876543210
   CF_API_TOKEN=aBcD...your long token...
   ```
   Leave `RESEND_API_KEY=` blank unless David has given you one.
3. Click **File > Save As**. In **File name** type exactly `".env"` (including the quote marks). In **Save as type** choose **All files**. Save it in the same folder, `C:\bvs-vehicle-feed`.
4. Don't share the `.env` file with anyone. It contains the token.

## 5. Test that Chrome gets through
1. Press the Windows key, type `cmd` and press Enter. In the black window type these two lines, pressing Enter after each:
   ```
   cd C:\bvs-vehicle-feed
   run-crawl.bat probe
   ```
2. The very first time, it spends about a minute installing a small component (needs internet). Then a Chrome window opens on screen and loads the stock list and one vehicle, 20 seconds apart.
3. If Chrome shows a "Verify you are human" box, tick it. This is only needed occasionally. The crawl remembers it afterwards in the `chrome-profile` folder.
4. At the end you should see **vehicle data found: YES** and **PROBE OK**. If you see **PROBE FAILED**, send David the text in the window.

## 6. First full run
1. Double-click **run-crawl.bat**. A black window shows progress, and a Chrome window appears minimised in the taskbar.
2. The first run takes about 30 minutes because it politely waits 20 seconds between pages. Leave both windows open and the PC awake.
3. At the end it says **DONE: the feed was updated.** Press any key to close. If it says **PROBLEM**, open the newest file in `C:\bvs-vehicle-feed\logs` and send it to David.
4. Check the feed: open `https://bvs-vehicle-feed.<your-subdomain>.workers.dev/status/<your token>` in your browser. `itemsInFeed` should be about 65 to 70. (David has your Worker address and token.)

If a run keeps failing with "blocked by Cloudflare", run it with Chrome visible so you can see what the site is showing: `run-crawl.bat show`.

## 7. Make it run every day (Task Scheduler)
1. Press the Windows key, type `Task Scheduler` and open it.
2. In the right-hand panel click **Create Task** (not "Create Basic Task").
3. **General** tab: Name `BVS vehicle feed crawl`. Choose **Run only when user is logged on**. (It has to be this one: Chrome needs your desktop to open in.)
4. **Triggers** tab: **New**, set **Daily**, start time **09:00:00**, click OK.
5. **Actions** tab: **New**, Action **Start a program**, then fill in:
   - Program/script: `C:\bvs-vehicle-feed\run-crawl.bat`
   - Add arguments: `auto`
   - Start in: `C:\bvs-vehicle-feed`
   
   Click OK.
6. **Conditions** tab: untick **Start the task only if the computer is on AC power** (laptops). Tick **Start only if the following network connection is available** and leave it on **Any connection**.
7. **Settings** tab:
   - Tick **Run task as soon as possible after a scheduled start is missed**. This catches up when the PC was off at 09:00.
   - Tick **If the task fails, restart every** `10 minutes`, **Attempt to restart up to** `3` times.
   - Tick **Stop the task if it runs longer than** and choose `3 hours`.
8. Click **OK**. (If Windows asks for your password, enter it.)
9. Test it: right-click the task in the list and choose **Run**. A window should appear and the crawl should start. Note that this runs a full crawl (about 10 minutes when there's little to do).

Google collects the feed at 06:00 each morning, so a 09:00 crawl is picked up the next morning.

## Everyday notes
- Each day's output is saved in `C:\bvs-vehicle-feed\logs\crawl-YYYY-MM-DD.log`. Delete old ones whenever you like.
- To update the software later: download a new ZIP (step 2) and copy its files over the old folder. Your `.env` and `logs` stay as they are.
- To stop the daily crawl: in Task Scheduler right-click the task and choose **Disable**.
- The crawl uses its own separate Chrome profile (`chrome-profile` folder), so your everyday Chrome, bookmarks and passwords aren't touched, and you can use Chrome as normal while it runs. Don't delete `chrome-profile` unless asked: it holds the site's "you're a real browser" cookie.
- **"Google Chrome was not found"**: install Chrome, or put its location in `.env` as `CHROME_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe`.
- **"already open (another crawl running?)"**: a previous crawl's Chrome is still running. Close it from the taskbar or restart the PC, then try again.
