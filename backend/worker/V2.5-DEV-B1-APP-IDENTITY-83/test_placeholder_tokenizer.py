import unittest
from placeholder_tokenizer import TokenizerError, placeholders, validate_bind_count

class PlaceholderTokenizerTests(unittest.TestCase):
    def test_01_anonymous_placeholders_in_order(self):
        p=placeholders("INSERT INTO t(a,b) VALUES (?, ?)")
        self.assertEqual([(x.ordinal,x.offset) for x in p],[(1,27),(2,30)])

    def test_02_question_marks_inside_single_string_ignored(self):
        self.assertEqual(len(placeholders("SELECT '?' AS q, ?")),1)

    def test_03_doubled_single_quote_escape(self):
        self.assertEqual(len(placeholders("SELECT 'it''s ?' , ?")),1)

    def test_04_double_quote_identifier_and_escape(self):
        self.assertEqual(len(placeholders('SELECT "a""?b", ?')),1)

    def test_05_backtick_identifier_and_escape(self):
        self.assertEqual(len(placeholders("SELECT `a``?b`, ?")),1)

    def test_06_bracket_identifier_and_escape(self):
        self.assertEqual(len(placeholders("SELECT [a]]?b], ?")),1)

    def test_07_line_comment_ignored(self):
        self.assertEqual(len(placeholders("SELECT ? -- ? ignored\n, ?")),2)

    def test_08_block_comment_ignored(self):
        self.assertEqual(len(placeholders("SELECT /* ? ignored */ ?")),1)

    def test_09_numbered_placeholder_rejected(self):
        with self.assertRaises(TokenizerError): placeholders("SELECT ?1")

    def test_10_named_colon_rejected(self):
        with self.assertRaises(TokenizerError): placeholders("SELECT :value")

    def test_11_named_at_rejected(self):
        with self.assertRaises(TokenizerError): placeholders("SELECT @value")

    def test_12_named_dollar_rejected(self):
        with self.assertRaises(TokenizerError): placeholders("SELECT $value")

    def test_13_numeric_named_parameters_rejected(self):
        for marker in (":1", "@1", "$1"):
            with self.subTest(marker=marker), self.assertRaises(TokenizerError):
                placeholders("SELECT " + marker)

    def test_14_empty_sql_rejected(self):
        with self.assertRaises(TokenizerError):
            placeholders("")

    def test_15_unterminated_quotes_rejected(self):
        for sql in ("SELECT 'x", 'SELECT "x', "SELECT `x", "SELECT [x"):
            with self.subTest(sql=sql), self.assertRaises(TokenizerError):
                placeholders(sql)

    def test_16_unterminated_comments_rejected(self):
        with self.assertRaises(TokenizerError): placeholders("SELECT /* x")
    
    def test_17_bind_count_mismatch_rejected(self):
        with self.assertRaises(TokenizerError):
            validate_bind_count("SELECT ?, ?",1)

    def test_18_valid_bind_count(self):
        self.assertEqual(len(validate_bind_count("SELECT ?, ?",2)),2)

if __name__ == "__main__":
    unittest.main()
