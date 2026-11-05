import XCTest
final class VoiceRoomsUITests: XCTestCase {
    private func openPreview() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-previewURL", "http://127.0.0.1:5199/?preview=call"]
        app.launch()
        XCTAssertTrue(app.webViews.staticTexts["Вечерний разговор"].waitForExistence(timeout: 30))
        return app
    }
    func testPhoneCallControlsAndChat() {
        let app = openPreview()
        let microphone = app.webViews.buttons["Выключить микрофон"]
        XCTAssertTrue(microphone.exists)
        microphone.tap()
        XCTAssertTrue(app.webViews.buttons["Включить микрофон"].waitForExistence(timeout: 5))
        app.webViews.buttons["Чат"].tap()
        XCTAssertTrue(app.webViews.staticTexts["Чат комнаты"].waitForExistence(timeout: 5))
        let input = app.webViews.textFields["Сообщение"]
        XCTAssertTrue(input.exists)
        input.tap()
        input.typeText("Проверка приложения")
        app.webViews.buttons["Отправить сообщение"].tap()
        XCTAssertTrue(app.webViews.staticTexts["Проверка приложения"].waitForExistence(timeout: 5))
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "iPhone-chat-keyboard"
        shot.lifetime = .keepAlways
        add(shot)
    }
    func testParticipantsPanel() {
        let app = openPreview()
        app.webViews.buttons["Участники"].tap()
        XCTAssertTrue(app.webViews.staticTexts["Управление комнатой"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.webViews.staticTexts["Даша"].exists)
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "iPhone-participants"
        shot.lifetime = .keepAlways
        add(shot)
    }
}
